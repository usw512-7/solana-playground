import { ITerminalOptions, Terminal as XTerm } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { WebLinksAddon } from "xterm-addon-web-links";

import PgTty from "./tty";
import PgShell from "./shell";
import {
  GITHUB_URL,
  Id,
  OTHER_ERROR,
  PROGRAM_ERROR,
  PROJECT_NAME,
  RPC_ERROR,
  SERVER_ERROR,
} from "../../../constants";
import { TerminalAction } from "../../../state";
import { PgCommon } from "../common";
import { PgConnection } from "../connection";
import { PgWallet } from "../wallet";
import {
  Wasm,
  WasmPkg,
} from "../../../components/Panels/Main/Terminal/useWasm";

enum TextState {
  SUCCESS = 0,
  ERROR = 1,
  WARNING = 2,
  INFO = 3,
  PRIMARY = 4, // Primary theme color
}

interface TextInfo {
  text: string;
  state: TextState;
}

export class PgTerminal {
  /**
   * Default height of the terminal
   */
  static get DEFAULT_HEIGHT() {
    return Math.floor(window.innerHeight / 4);
  }

  /**
   * Minimum height of the terminal(in px)
   */
  static readonly MIN_HEIGHT = 36;

  /**
   * Maximum height for the terminal
   * This is to fix bottom of the terminal not being visible due to
   * incorrect resizing
   */
  static get MAX_HEIGHT() {
    const tabHeight = document
      .getElementById(Id.TABS)
      ?.getBoundingClientRect()?.height;
    const bottomHeight = document
      .getElementById(Id.BOTTOM)
      ?.getBoundingClientRect()?.height;

    if (tabHeight && bottomHeight) {
      return window.innerHeight - (tabHeight + bottomHeight);
    }

    return this.DEFAULT_HEIGHT;
  }

  /**
   * Welcome text
   */
  static readonly DEFAULT_TEXT = `Welcome to ${PgTerminal.bold(PROJECT_NAME)}.

Popular crates for Solana development are available to use.

See the list of available crates and request new crates from: ${PgTerminal.underline(
    GITHUB_URL
  )}

Type ${PgTerminal.bold("help")} to see all commands.`;

  /**
   * Help command text
   */
  static readonly HELP_TEXT = `COMMANDS:
  build                      Build your program
  connect                    Toggle connection to Playground Wallet
  deploy                     Deploy your program
  solana                     Access Solana CLI commands
`;

  /**
   * Default prompt string before entering commands
   */
  static readonly PROMPT = "$ ";

  /**
   * Event name for logging terminal
   */
  static readonly EVT_NAME_TERMINAL_LOG = "terminallog";
  static readonly EVT_NAME_TERMINAL_STATE = "terminalstate";
  static readonly EVT_NAME_TERMINAL_ENABLE = "terminalenable";
  static readonly EVT_NAME_TERMINAL_DISABLE = "terminaldisable";
  static readonly EVT_NAME_LOAD_WASM = "terminalloadwasm";
  static readonly EVT_NAME_RUN_LAST_CMD = "terminalrunlastcmd";

  // Emojis
  static readonly CROSS = "❌";
  static readonly CHECKMARK = "✅";

  /**
   * These text-state pairs will be used to give colors before printing
   */
  private static readonly TEXTS: TextInfo[] = [
    { text: "error", state: TextState.ERROR },
    { text: "Error", state: TextState.ERROR },
    { text: "warning", state: TextState.WARNING },
    { text: "USAGE:", state: TextState.PRIMARY },
    { text: "OPTIONS:", state: TextState.PRIMARY },
    { text: "SUBCOMMANDS:", state: TextState.PRIMARY },
    { text: "COMMANDS:", state: TextState.PRIMARY },
  ];

  /**
   * Give color to the specified keywords in TEXTS
   */
  static colorText(text: string) {
    for (const textInfo of this.TEXTS) {
      text = text.replaceAll(textInfo.text, this.getColorFromState(textInfo));
    }

    return text;
  }

  /**
   * Helper function for colorText
   */
  private static getColorFromState(textInfo: TextInfo) {
    switch (textInfo.state) {
      case TextState.SUCCESS:
        return this.success(textInfo.text);
      case TextState.ERROR:
        return this.error(textInfo.text);
      case TextState.WARNING:
        return this.warning(textInfo.text);
      case TextState.INFO:
        return this.info(textInfo.text);
      case TextState.PRIMARY:
        return this.primary(textInfo.text);
      default:
        return textInfo.text;
    }
  }

  static success(text: string) {
    return `\x1B[1;32m${text}\x1B[0m`;
  }

  static error(text: string) {
    return `\x1B[1;31m${text}\x1B[0m`;
  }

  static warning(text: string) {
    return `\x1B[1;33m${text}\x1B[0m`;
  }

  static info(text: string) {
    return `\x1B[1;34m${text}\x1B[0m`;
  }

  static primary(text: string) {
    return `\x1B[1;35m${text}\x1B[0m`;
  }

  static bold(text: string) {
    return `\x1B[1m${text}\x1B[0m`;
  }

  static italic(text: string) {
    return `\x1B[3m${text}\x1B[0m`;
  }

  static underline(text: string) {
    return `\x1B[4m${text}\x1B[0m`;
  }

  /**
   * Edit build stderr that is returned from the build request
   */
  static editStderr = (stderr: string, uuid: string) => {
    // Remove full path
    stderr = stderr.replace(/\s\(\/home.+?(?=\s)/g, "");

    // Remove uuid from folders
    stderr = stderr.replaceAll(uuid, "");

    // Remove rustc error line
    let startIndex = stderr.indexOf("For more");
    if (startIndex !== -1) {
      const endIndex = stderr.indexOf("\n", startIndex);
      stderr = stderr.substring(0, startIndex) + stderr.substring(endIndex + 1);
    }

    // Remove Compiling message
    stderr = stderr.replace("Compiling solpg v0.1.0\n", "");

    // Remove whitespace before 'Finished'
    startIndex = stderr.indexOf("Finished release");
    if (startIndex !== -1) {
      const whiteSpaceStartIndex = startIndex - 7; // 7 is the most amount of whitespace
      stderr =
        stderr.substring(0, whiteSpaceStartIndex) + // Until whitespace start
        stderr.substring(whiteSpaceStartIndex, startIndex).replaceAll(" ", "") +
        this.success("Build successful. ") +
        "Completed" +
        stderr
          .substring(stderr.indexOf(" in", startIndex))
          .replace("\n", ".\n"); // Time passed
    }

    return stderr;
  };

  /**
   * Make error messages more friendly
   */
  static convertErrorMessage(msg: string) {
    // Hex program errors
    for (const programErrorCode in PROGRAM_ERROR) {
      if (msg.endsWith("0x" + programErrorCode.toLowerCase())) {
        const parts = msg.split(":");

        let ixIndex = parts[2][parts[2].length - 1];
        if (!PgCommon.isInt(ixIndex)) ixIndex = "0";
        const programError = PROGRAM_ERROR[programErrorCode];

        msg = `\n${this.bold("Instruction index:")} ${ixIndex}\n${this.bold(
          "Reason:"
        )} ${programError}`;

        return msg;
      }
    }

    // Descriptive program errors
    if (msg.startsWith("failed to send")) {
      const parts = msg.split(":");
      // With ix index
      if (parts.length === 4) {
        const ixIndex = parts[2][parts[2].length - 1];
        const programError = parts[3][1].toUpperCase() + parts[3].substring(2);

        msg = `\n${this.bold("Instruction index:")} ${ixIndex}\n${this.bold(
          "Reason:"
        )} ${programError}.`;

        return msg;
      }

      // Without ix index
      const programError = parts[2][1].toUpperCase() + parts[2].substring(2);
      msg = `\n${this.bold("Reason:")} ${programError}.`;

      return msg;
    }

    // Rpc errors
    for (const rpcError in RPC_ERROR) {
      if (msg.includes(rpcError)) {
        msg = RPC_ERROR[rpcError];
        return msg;
      }
    }

    // Server errors
    for (const serverError in SERVER_ERROR) {
      if (msg === serverError) {
        msg = SERVER_ERROR[serverError];
        return msg;
      }
    }

    // Other errors
    for (const otherError in OTHER_ERROR) {
      if (msg === otherError) {
        msg = OTHER_ERROR[otherError];
        return msg;
      }
    }

    return msg;
  }

  /**
   * Runs when user presses a key when the terminal is in focus
   */
  static isCharValid(char: string) {
    return char.match(/^[\w.\-/+\\='":;|,?><`~!@#$%^&*()[\]{} ]+$/);
  }

  /**
   * Gets whether the terminal is focused or in blur
   */
  static isTerminalFocused() {
    return document
      .getElementsByClassName("terminal xterm xterm-dom-renderer-owner-1")[0]
      ?.classList.contains("focus");
  }

  /**
   * Get the remaining Solana CLI args
   * (endpoint: string, commitment: string, keypairBytes: Uint8Array)
   */
  static getSolanaCliArgs() {
    let args = [];

    const endpoint = PgConnection.endpoint;
    args.push(endpoint);

    const commitment = PgConnection.commitment;
    args.push(commitment);

    const keypairBytes = PgWallet.keypairBytes;
    args.push(keypairBytes);

    return args;
  }

  /**
   * This function runs when user presses `Enter` in terminal
   * @returns if the command is valid
   */
  static parseCommand(cmd: string, wasm?: Wasm) {
    cmd = cmd.trim();
    if (cmd === "help") {
      this.logWasm(this.HELP_TEXT);
      this.enable();
      return true;
    }
    if (cmd === "build") {
      this.setTerminalState(TerminalAction.buildStart);
      return true;
    }
    if (cmd === "connect") {
      this.setTerminalState(TerminalAction.walletConnectOrSetupStart);
      return true;
    }
    if (cmd === "deploy") {
      if (PgWallet.checkIsPgConnected())
        this.setTerminalState(TerminalAction.deployStart);

      return true;
    }

    // This guarantees command only start with the specified command name
    // solana-keygen would not count for cmdName === "solana"
    const cmdName = cmd.split(" ")?.at(0);

    if (cmdName === "solana") {
      if (wasm?.parseSolana) {
        if (PgWallet.checkIsPgConnected()) {
          // @ts-ignore
          wasm.parseSolana(cmd, ...this.getSolanaCliArgs());

          // TODO: enable from wasm when the command is over
          setTimeout(() => this.enable(), 1000);
        }
      } else {
        PgTerminal.loadWasm(WasmPkg.SOLANA_CLI);
      }

      return true;
    }

    return false;
  }

  /**
   * Set terminal state from anywhere
   */
  static setTerminalState(action: TerminalAction) {
    PgCommon.createAndDispatchCustomEvent(this.EVT_NAME_TERMINAL_STATE, {
      action,
    });
  }

  /**
   * Dispatch enable terminal custom event
   */
  static enable() {
    PgCommon.createAndDispatchCustomEvent(this.EVT_NAME_TERMINAL_ENABLE, {
      enabled: true,
    });
  }

  /**
   * Dispatch disable terminal custom event
   */
  static disable() {
    PgCommon.createAndDispatchCustomEvent(this.EVT_NAME_TERMINAL_DISABLE, {
      enabled: false,
    });
  }

  /**
   * Log terminal messages from anywhere
   *
   * Mainly used from WASM
   */
  static logWasm(msg: string) {
    PgCommon.createAndDispatchCustomEvent(this.EVT_NAME_TERMINAL_LOG, { msg });
  }

  /**
   * Dispatch disable terminal custom event
   */
  static loadWasm(pkg: WasmPkg) {
    PgCommon.createAndDispatchCustomEvent(this.EVT_NAME_LOAD_WASM, {
      pkg,
    });
  }

  /**
   * Dispatch run last command custom event
   */
  static runLastCmd() {
    PgCommon.createAndDispatchCustomEvent(this.EVT_NAME_RUN_LAST_CMD);
  }
}

export class PgTerm {
  xterm: XTerm;
  container: HTMLElement | undefined;
  webLinksAddon: WebLinksAddon;
  fitAddon: FitAddon;

  pgTty: PgTty;
  pgShell: PgShell;

  pasteEvent: any;
  resizeEvent: any;
  dataEvent: any;

  isOpen: boolean;
  fitTimeoutId?: NodeJS.Timeout;

  constructor(xtermOptions?: ITerminalOptions) {
    // Create xterm element
    this.xterm = new XTerm(xtermOptions);

    this.resizeEvent = this.xterm.onResize(this.handleTermResize);
    this.xterm.onKey((keyEvent: { key: string; domEvent: KeyboardEvent }) => {
      if (keyEvent.key === " ") {
        keyEvent.domEvent.preventDefault();
        return false;
      }
    });

    // Set up  container
    this.container = undefined;

    // Load addons
    this.webLinksAddon = new WebLinksAddon();
    this.fitAddon = new FitAddon();
    this.xterm.loadAddon(this.fitAddon);
    this.xterm.loadAddon(this.webLinksAddon);

    // Create  Shell and TTY
    this.pgTty = new PgTty(this.xterm);
    this.pgShell = new PgShell(this.pgTty);

    this.dataEvent = this.xterm.onData(this.pgShell.handleTermData);

    this.isOpen = false;
  }

  attachCustomKeyEventHandler(
    customEventHandler: (e: KeyboardEvent) => boolean
  ) {
    this.xterm.attachCustomKeyEventHandler(customEventHandler);
  }

  setWasm(wasm: Wasm) {
    this.pgShell.setWasm(wasm);
  }

  open(container: HTMLElement) {
    this.container = container;

    this.xterm.open(container);
    this.isOpen = true;

    // Print welcome text
    this.println(PgTerminal.DEFAULT_TEXT);

    this.enable();
  }

  fit() {
    this.fitAddon.fit();

    // Timeout fixes prompt message not showing after resizing
    if (this.fitTimeoutId) clearTimeout(this.fitTimeoutId);

    this.fitTimeoutId = setTimeout(() => {
      if (
        this.pgShell.isPrompting() &&
        !this.pgTty.getInputStartsWithPrompt()
      ) {
        const input = this.pgTty.getInput();
        if (input) {
          this.pgTty.clearInput();
          this.pgShell.prompt();
          this.pgTty.print(input);
        } else {
          this.pgShell.prompt();
        }
      }
    }, 1000); // time needs to be lower than specified fit interval in Terminal component
  }

  focus() {
    this.xterm.focus();
    this.scrollToCursor();
  }

  scrollToCursor() {
    if (!this.container) {
      return;
    }

    // We don't need cursorX, since we want to start at the beginning of the terminal.
    const cursorY = this.pgTty.getBuffer().cursorY;
    const size = this.pgTty.getSize();

    const containerBoundingClientRect = this.container.getBoundingClientRect();

    // Find how much to scroll because of our cursor
    const cursorOffsetY =
      (cursorY / size.rows) * containerBoundingClientRect.height;

    let scrollX = containerBoundingClientRect.left;
    let scrollY = containerBoundingClientRect.top + cursorOffsetY + 10;

    if (scrollX < 0) {
      scrollX = 0;
    }
    if (scrollY > document.body.scrollHeight) {
      scrollY = document.body.scrollHeight;
    }

    window.scrollTo(scrollX, scrollY);
  }

  print(message: string, sync?: boolean) {
    // For some reason, double new lines are not respected. Thus, fixing that here
    message = message.replace(/\n\n/g, "\n \n");

    if (!this.isOpen) {
      return;
    }

    if (this.pgShell.isPrompting()) {
      // Cancel the current prompt and restart
      this.pgShell.printAndRestartPrompt(() => {
        this.pgTty.print(message + "\n", sync);
        return undefined;
      });
      return;
    }

    this.pgTty.print(message, sync);
  }

  println(message: string, sync?: boolean) {
    this.print(message + "\n", sync);
  }

  runCommand(line: string) {
    if (this.pgShell.isPrompting()) {
      this.pgTty.setInput(line);
      this.pgShell.handleReadComplete();
    }
  }

  destroy() {
    this.xterm.dispose();
    // @ts-ignore
    delete this.xterm;
  }

  onPaste(data: string) {
    this.pgTty.print(data);
  }

  clear() {
    this.pgTty.clearTty();
    this.pgTty.print(`${PgTerminal.PROMPT}${this.pgTty.getInput()}`);
  }

  /**
   * Disable shell:
   * - Disables shell
   * - Clears current line for  for actions that were committed from outside of terminal
   * like pressing build button
   */
  disable() {
    this.pgShell._active = false;
    this.pgTty.clearCurrentLine();
  }

  /**
   * Enable shell
   */
  enable() {
    setTimeout(() => {
      this.pgShell._active = true;
      this.pgShell.prompt();
      this.pgTty.read(""); // Enables history
    }, 10);
  }

  /**
   * Handle terminal resize
   *
   * This function clears the prompt using the previous configuration,
   * updates the cached terminal size information and then re-renders the
   * input. This leads (most of the times) into a better formatted input.
   */
  handleTermResize = (data: { rows: number; cols: number }) => {
    const { rows, cols } = data;
    this.pgTty.clearInput();
    this.pgTty.setTermSize(cols, rows);
    this.pgTty.setInput(this.pgTty.getInput(), true);
  };

  /**
   * Runs the last command if it exists
   *
   * This function is useful for running wasm cli packages after first loading
   */
  runLastCmd() {
    this.pgTty.setInput(this.pgShell.history.getPrevious());
    this.pgShell.handleReadComplete();
  }
}
