import { IBMiClient } from "./client.js";
import { Tools } from "./Tools.js";
import { Variables } from "./variables.js";
export var CompileTools;
(function (CompileTools) {
    CompileTools.NEWLINE = `\r\n`;
    CompileTools.DID_NOT_RUN = -123;
    async function runCommand(connection, options, events = {}) {
        const config = connection.getConfig();
        const cwd = options.cwd;
        const variables = new Variables(connection, options.env);
        const ileSetup = {
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
                    events.writeEvent(`Current library: ` + ileSetup.currentLibrary + CompileTools.NEWLINE);
                    events.writeEvent(`Library list: ` + ileSetup.libraryList.join(` `) + CompileTools.NEWLINE);
                }
                if (options.cwd) {
                    events.writeEvent(`Working directory: ` + options.cwd + CompileTools.NEWLINE);
                }
                events.writeEvent(`Commands:\n${commands.map(cmd => `\t${cmd}\n`).join(``)}` + CompileTools.NEWLINE);
            }
            let commandResult;
            const env = options.environment || "ile";
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
            code: CompileTools.DID_NOT_RUN,
            command: options.command,
            stdout: "",
            stderr: "Command execution failed. (No command)"
        };
    }
    CompileTools.runCommand = runCommand;
    function buildLibraryList(config) {
        return config.libraryList.slice(0).reverse();
    }
    function buildLiblistCommands(connection, config) {
        const defaultLibs = config.libraryList.length ? config.libraryList : [];
        return [
            `liblist -d ${IBMiClient.escapeForShell(defaultLibs.join(` `))}`,
            `liblist -c ${IBMiClient.escapeForShell(config.currentLibrary)}`,
            `liblist -a ${IBMiClient.escapeForShell(buildLibraryList(config).join(` `))}`
        ];
    }
})(CompileTools || (CompileTools = {}));
