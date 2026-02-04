import { IBMiClient } from "./client.js";
import { Tools } from "./Tools.js";
import { Variables } from "./variables.js";
import { CommandResult, RemoteCommand, ActionEnvironment } from "./types.js";

export interface ILELibrarySettings {
  currentLibrary: string;
  libraryList: string[];
}

export namespace CompileTools {
  export const NEWLINE = `\r\n`;
  export const DID_NOT_RUN = -123;

  interface RunCommandEvents {
    writeEvent?: (content: string) => void;
    commandConfirm?: (command: string) => Promise<string>;
    updateProgress?: (message: string) => void;
  }

  export async function runCommand(connection: IBMiClient, options: RemoteCommand, events: RunCommandEvents = {}): Promise<CommandResult> {
    const config = connection.getConfig();
    const cwd = options.cwd;
    const variables = new Variables(connection, options.env);

    const ileSetup: ILELibrarySettings = {
      currentLibrary: variables.get(`&CURLIB`) || config.currentLibrary || "",
      libraryList: variables.get(`&LIBL`)?.split(` `) || config.libraryList || []
    };

    ileSetup.libraryList = ileSetup.libraryList.filter(Tools.distinct);
    const libraryList = buildLibraryList(ileSetup);
    variables.set(`&LIBLS`, libraryList.join(` `));

    let commandString = variables.expand(options.command);
    if (events.commandConfirm) {
      events.updateProgress?.(" - Prompting...");
      commandString = await events.commandConfirm(commandString);
      events.updateProgress?.("");
    }

    if (commandString) {
      const commands = commandString.split(`\n`).filter(cmd => cmd.trim().length > 0);
      if (events.writeEvent) {
        if ((options.environment || "ile") === "ile" && !options.noLibList) {
          events.writeEvent(`Current library: ` + ileSetup.currentLibrary + NEWLINE);
          events.writeEvent(`Library list: ` + ileSetup.libraryList.join(` `) + NEWLINE);
        }
        if (options.cwd) {
          events.writeEvent(`Working directory: ` + options.cwd + NEWLINE);
        }
        events.writeEvent(`Commands:\n${commands.map(cmd => `\t${cmd}\n`).join(``)}` + NEWLINE);
      }

      let commandResult: CommandResult;
      const env: ActionEnvironment = options.environment || "ile";

      switch (env) {
        case "pase":
          commandResult = await connection.sendCommand({
            command: commands.join(` && `),
            directory: cwd,
            env: variables.toPaseVariables()
          });
          break;
        case "qsh":
          commandResult = await connection.sendQsh({
            command: [
              ...(options.noLibList ? [] : buildLiblistCommands(connection, ileSetup)),
              ...commands
            ].join(` && `),
            directory: cwd
          });
          break;
        case "ile":
        default:
          commandResult = await connection.sendQsh({
            command: [
              ...(options.noLibList ? [] : buildLiblistCommands(connection, ileSetup)),
              ...commands.map(cmd => `system \"${IBMiClient.escapeForShell(cmd)}\"`)
            ].join(` && `),
            directory: cwd
          });
          break;
      }

      commandResult.command = commandString;
      return commandResult;
    }

    return {
      code: DID_NOT_RUN,
      command: options.command,
      stdout: "",
      stderr: "Command execution failed. (No command)"
    };
  }

  function buildLibraryList(config: ILELibrarySettings): string[] {
    return config.libraryList.slice(0).reverse();
  }

  function buildLiblistCommands(connection: IBMiClient, config: ILELibrarySettings): string[] {
    const defaultLibs = config.libraryList.length ? config.libraryList : [];
    return [
      `liblist -d ${IBMiClient.escapeForShell(defaultLibs.join(` `))}`,
      `liblist -c ${IBMiClient.escapeForShell(config.currentLibrary)}`,
      `liblist -a ${IBMiClient.escapeForShell(buildLibraryList(config).join(` `))}`
    ];
  }
}
