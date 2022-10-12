import { Keypair, PublicKey } from "@solana/web3.js";

import { Emoji } from "../../../../../../constants";
import { PgConnection } from "../../../../connection";
import { PgTerminal } from "../../../../terminal";
import { PgValidator } from "../../../../validator";
import { loadConfigData, getMetaplex, loadCache } from "../../utils";
import { checkName, checkSellerFeeBasisPoints, checkSymbol } from "../validate";
import { createCollection } from "./collection";

export const processDeploy = async (rpcUrl: string = PgConnection.endpoint) => {
  const term = await PgTerminal.get();

  // Load the cache file (this needs to have been created by the upload command)
  const cache = await loadCache();
  if (cache.isItemsEmpty()) {
    throw new Error(
      "No cache items found - run 'sugar upload' to create the cache file first."
    );
  }

  // Check that all metadata information are present and have the correct length
  for (const index in cache.items) {
    const item = cache.items[index];
    if (!item.name) {
      throw new Error(`Missing name in metadata index ${index}`);
    } else {
      checkName(item.name);
    }

    if (!item.metadata_link) {
      throw new Error(`Missing metadata link for cache item ${index}`);
    }
  }

  const configData = await loadConfigData();

  let candyMachinePkStr = cache.program.candyMachine;

  // Check the candy machine data
  const numItems = configData.size;
  const hidden = configData.hiddenSettings ? 1 : 0;
  const collectionInCache = cache.items["-1"] ? 1 : 0;
  let itemsRedeemed = false;

  const cacheItemsSansCollection =
    Object.keys(cache.items).length - collectionInCache;

  if (!numItems.eqn(cacheItemsSansCollection)) {
    throw new Error(
      [
        `Number of items (${numItems}) do not match cache items (${cacheItemsSansCollection}).`,
        "Item number in the config should only include asset files, not the collection file.",
      ].join("")
    );
  } else {
    checkSymbol(configData.symbol);
    checkSellerFeeBasisPoints(configData.royalties);
  }

  const collectionStepNumber = !candyMachinePkStr ? collectionInCache : 0;
  const totalSteps = 2 + collectionStepNumber - hidden;

  const metaplex = await getMetaplex(rpcUrl);
  const candyClient = metaplex.candyMachines();
  let candyPubkey: PublicKey;

  if (!candyMachinePkStr) {
    const candyKp = new Keypair();
    candyPubkey = candyKp.publicKey;

    // Check collection, required in v3
    const collectionItem = cache.items["-1"];
    if (!collectionItem) {
      throw new Error("Missing collection item in cache");
    }

    term.println(
      `\n[1/${totalSteps}] ${Emoji.COLLECTION} Creating collection NFT for candy machine`
    );

    let collectionMintPk: PublicKey;
    if (collectionItem.onChain) {
      term.println("\nCollection mint already deployed.");
      collectionMintPk = new PublicKey(cache.program.collectionMint);
    } else {
      // Create collection
      collectionMintPk = await createCollection(metaplex, cache, configData);

      // const { nft: collectionNft } = await metaplex.nfts().create({
      //   isCollection: true,
      //   name: collectionItem.name,
      //   uri: collectionItem.metadata_link,
      //   sellerFeeBasisPoints: configData.royalties,
      //   isMutable: configData.isMutable,
      //   creators: configData.creators,
      //   symbol: configData.symbol,
      // });
      // collectionMintPk = collectionNft.address;

      // collectionItem.onChain = true;
      // cache.program.collectionMint = collectionMintPk.toBase58();
      // await cache.syncFile();

      term.println(
        `${PgTerminal.bold(
          "Collection mint ID:"
        )} ${collectionMintPk.toBase58()}`
      );
    }

    // Create candy machine
    term.println(`[2/${totalSteps}] ${Emoji.CANDY} Creating candy machine`);

    // Save the candy machine pubkey to the cache before attempting to deploy
    // in case the transaction doesn't confirm in time the next run should pickup
    // the pubkey  and check if the deploy succeeded
    cache.program.setCandyMachine(candyPubkey);
    await cache.syncFile();

    await candyClient.create({
      candyMachine: candyKp,
      collection: {
        address: collectionMintPk,
        updateAuthority: metaplex.identity(),
      },
      itemsAvailable: configData.size,
      sellerFeeBasisPoints: configData.royalties,
      symbol: configData.symbol,
      creators: configData.creators,
      isMutable: configData.isMutable,
    });
  } else {
    term.println(`[1/${totalSteps}] ${Emoji.CANDY} Loading candy machine`);

    if (!PgValidator.isPubkey(candyMachinePkStr)) {
      throw new Error(
        `Invalid candy machine address in cache file: '${candyMachinePkStr}'`
      );
    }
    candyPubkey = new PublicKey(candyMachinePkStr);

    try {
      const candyState = await candyClient.findByAddress({
        address: candyPubkey,
      });
      if (candyState.itemsMinted) {
        itemsRedeemed = true;
      }
    } catch {
      throw new Error("Candy machine from cache does't exist on chain!");
    }
  }

  term.println(
    `${PgTerminal.bold("Candy machine ID:")} ${candyPubkey.toBase58()}`
  );

  console.log(itemsRedeemed);

  // Hidden Settings check needs to be the last action in this command, so that
  // we can update the hash with the final cache state.
  if (!hidden) {
    const stepNum = 2 + collectionStepNumber;
    term.println(
      `\n[${stepNum}/${totalSteps}] ${Emoji.PAPER} Writing config lines`
    );

    const configLineChunks = cache.getConfigLineChunks();
    if (!configLineChunks[0]?.items.length) {
      term.println(`\nAll config lines deployed.`);
    } else {
      const candy = await candyClient.findByAddress({ address: candyPubkey });

      const getTotalConfigLinesUntilChunkN = (n: number) => {
        return new Array(n)
          .fill(null)
          .reduce(
            (acc, _cur, i) =>
              acc + (n === i ? 0 : configLineChunks[i].items.length),
            0
          );
      };

      // Periodically save the cache
      const saveCacheIntervalId = setInterval(() => cache.syncFile(), 5000);

      // Show progress bar
      PgTerminal.setProgress(0.1);
      let progressCount = 0;

      const CONCURRENT = 8;
      let errorCount = 0;

      await Promise.all(
        new Array(CONCURRENT).fill(null).map(async (_, i) => {
          for (let j = 0; ; j += CONCURRENT) {
            const currentChunk = configLineChunks[j + i];
            if (!currentChunk) break;

            try {
              await candyClient.insertItems({
                candyMachine: {
                  address: candyPubkey,
                  itemsAvailable: candy.itemsAvailable,
                  itemsLoaded: getTotalConfigLinesUntilChunkN(j + i),
                  itemSettings: {
                    // TODO: find from cache
                    type: "configLines",
                    isSequential: configData.isSequential,
                    prefixName: "",
                    nameLength: 32,
                    prefixUri: "",
                    uriLength: 200,
                  },
                },
                items: currentChunk.items,
              });

              for (const currentIndex of currentChunk.indices) {
                cache.updateItemAtIndex(currentIndex, {
                  onChain: true,
                });
              }
            } catch {
              errorCount++;
            } finally {
              progressCount++;
              PgTerminal.setProgress(
                (progressCount / configLineChunks.length) * 100
              );
            }
          }
        })
      );

      // Hide progress bar
      setTimeout(() => PgTerminal.setProgress(0), 1000);

      // Sync and refresh the file if it's already open
      clearInterval(saveCacheIntervalId);
      await cache.syncFile(true);

      if (errorCount) {
        throw new Error(
          `${errorCount}/${
            configLineChunks.length
          } of the write config line transactions has failed. Please re-run ${PgTerminal.bold(
            "'sugar deploy'"
          )}`
        );
      }
    }
  } else {
    // TODO:
    // // If hidden settings are enabled, update the hash value with the new cache file
    // term.println("\nCandy machine with hidden settings deployed.");
    // term.println(`\nHidden settings hash: ${}`, hashAndUpdate(configData))
    // term.println("\nUpdating candy machine state with new hash value:\n");
    // processUpdate()
  }
};
