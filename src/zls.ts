import { ExtensionContext, window, workspace } from "vscode";

import axios from "axios";
import camelCase from "camelcase";
import * as child_process from "child_process";
import * as fs from "fs";
import mkdirp from "mkdirp";
import semver, { SemVer } from "semver";
import * as vscode from "vscode";
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions
} from "vscode-languageclient/node";
import { execCmd, getExePath, getHostZigName, getZigPath, isWindows, shouldCheckUpdate } from "./zigUtil";

let outputChannel: vscode.OutputChannel;
let client: LanguageClient | null = null;

async function startClient() {
    const configuration = workspace.getConfiguration("zig.zls");
    const debugLog = configuration.get<boolean>("debugLog", false);

    const zlsPath = getZLSPath();

    const serverOptions: ServerOptions = {
        command: zlsPath,
        args: debugLog ? ["--enable-debug-log"] : [],
    };

    // Options to control the language client
    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: "file", language: "zig" }],
        outputChannel,
        middleware: {
            workspace: {
                async configuration(params, token, next) {
                    let indexOfAstCheck = null;
                    let indexOfZigPath = null;

                    for (const [index, param] of Object.entries(params.items)) {
                        if (param.section === "zls.zig_exe_path") {
                            param.section = "zig.path";
                            indexOfZigPath = index;
                        } else if (param.section === "zls.enable_ast_check_diagnostics") {
                            indexOfAstCheck = index;
                        } else {
                            param.section = `zig.zls.${camelCase(param.section.slice(4))}`;
                        }
                    }

                    const result = await next(params, token);

                    if (indexOfAstCheck !== null) {
                        result[indexOfAstCheck] = workspace.getConfiguration("zig").get<string>("astCheckProvider") === "zls";
                    }
                    if (indexOfZigPath !== null) {
                        result[indexOfZigPath] = getZigPath();
                    }

                    return result;
                }
            }
        }
    };

    // Create the language client and start the client.
    client = new LanguageClient(
        "zls",
        "Zig Language Server",
        serverOptions,
        clientOptions
    );

    return client.start().catch(reason => {
        window.showWarningMessage(`Failed to run Zig Language Server (ZLS): ${reason}`);
        client = null;
    }).then(() => {
        if (workspace.getConfiguration("zig").get<string>("formattingProvider") !== "zls") {
            client.getFeature("textDocument/formatting").dispose();
        }
    });
}

export async function stopClient() {
    if (client) client.stop();
    client = null;
}

// returns the file system path to the zls executable
export function getZLSPath(): string {
    const configuration = workspace.getConfiguration("zig.zls");
    const zlsPath = configuration.get<string | null>("path");
    return getExePath(zlsPath, "zls", "zig.zls.path");
}

const downloadsRoot = "https://zigtools-releases.nyc3.digitaloceanspaces.com/zls";

interface Version {
    date: string,
    builtWithZigVersion: string,
    zlsVersion: string,
    zlsMinimumBuildVersion: string,
    commit: string,
    targets: string[],
}

interface VersionIndex {
    latest: string,
    releases: Record<string, string>,
    versions: Record<string, Version>,
}

async function getVersionIndex(): Promise<VersionIndex> {
    const index = (await axios.get(`${downloadsRoot}/index.json`)).data;
    if (!index.versions[index.latest]) {
        window.showErrorMessage("Invalid ZLS version index; please contact a ZLS maintainer.");
        throw "Invalid ZLS version";
    }
    return index;
}

// checks whether there is newer version on master
async function checkUpdate(context: ExtensionContext) {
    const configuration = workspace.getConfiguration("zig.zls");
    const zlsPath = configuration.get<string>("path");
    const zigBinPath = vscode.Uri.joinPath(context.globalStorageUri, "zls_install", "zls").fsPath;
    if (!zlsPath.startsWith(zigBinPath)) return;

    // get current version
    const buffer = child_process.execFileSync(zlsPath, ["--version"]);
    const version = semver.parse(buffer.toString("utf8"));
    if (!version) return;

    // compare version triple if commit id is available
    if (version.build.length === 0) {
        // get latest tagged version
        // TODO update when releases are included
        window.showWarningMessage("Checking for new ZLS tagged releases does not work yet")
        return;
    }

    const index = await getVersionIndex();
    if (semver.eq(version, index.latest)) return;

    const response = await window.showInformationMessage(`New version of ZLS available`, "Install", "Ignore");
    if (response === "Install") {
        await installVersion(context, version);
    }
}

export async function install(context: ExtensionContext, ask: boolean) {
    const path = getZigPath();

    const buffer = child_process.execFileSync(path, ["version"]);
    let zigVersion = semver.parse(buffer.toString("utf8"));
    // Zig 0.9.0 was the first version to have a tagged zls release
    const zlsConfiguration = workspace.getConfiguration("zig.zls", null);
    if (semver.lt(zigVersion, "0.9.0")) {
        if (zlsConfiguration.get("path")) {
            window.showErrorMessage(`ZLS is not available for Zig version ${zigVersion}`);
        }
        await zlsConfiguration.update("path", undefined);
        return;
    }

    if (ask) {
        const result = await window.showInformationMessage(
            `Do you want to install ZLS (the Zig Language Server) for Zig version ${zigVersion}`,
            "Install", "Ignore"
        );
        if (result === "Ignore") {
            await zlsConfiguration.update("path", undefined);
            return;
        }
    }
    let zlsVersion;
    if (zigVersion.build.length !== 0) {
        // Nightly, install latest ZLS
        zlsVersion = semver.parse((await getVersionIndex()).latest);
    } else {
        // ZLS does not make releases for patches
        zlsVersion = zigVersion;
        zlsVersion.patch = 0;
    }

    try {
        await installVersion(context, zlsVersion);
    } catch (err) {
        window.showErrorMessage(`Unable to install ZLS ${zlsVersion} for Zig version ${zigVersion}: ${err}`);
    }
}

async function installVersion(context: ExtensionContext, version: SemVer) {
    const hostName = getHostZigName();

    await window.withProgress({
        title: "Installing zls...",
        location: vscode.ProgressLocation.Notification,
    }, async progress => {
        const installDir = vscode.Uri.joinPath(context.globalStorageUri, "zls_install");
        if (fs.existsSync(installDir.fsPath)) fs.rmSync(installDir.fsPath, { recursive: true, force: true });
        mkdirp.sync(installDir.fsPath);

        const binName = `zls${isWindows ? ".exe" : ""}`;
        const zlsBinPath = vscode.Uri.joinPath(installDir, binName).fsPath;

        progress.report({ message: "Downloading ZLS executable..." });
        let exe: Buffer;
        try {
            exe = (await axios.get(`${downloadsRoot}/${version.raw}/${hostName}/zls${isWindows ? ".exe" : ""}`, {
                responseType: "arraybuffer"
            })).data;
        } catch (err) {
            // Missing prebuilt binary is reported as AccessDenied
            if (err.response.status == 403) {
                window.showErrorMessage(`A prebuilt ZLS ${version} binary is not available for your system. You can build it yourself with https://github.com/zigtools/zls#from-source`);
                return;
            }
            throw err;
        }
        fs.writeFileSync(zlsBinPath, exe, "binary");
        fs.chmodSync(zlsBinPath, 0o755);

        let config = workspace.getConfiguration("zig.zls");
        await config.update("path", zlsBinPath, true);
    });
}

async function openConfig() {
    const zlsPath = getZLSPath();
    const buffer = child_process.execFileSync(zlsPath, ["--show-config-path"]);
    const path: string = buffer.toString("utf8").trimEnd();
    await vscode.window.showTextDocument(vscode.Uri.file(path), { preview: false });
}

function checkInstalled(): boolean {
    const zlsPath = workspace.getConfiguration("zig.zls").get<string | null>("path");
    if (zlsPath === null) window.showErrorMessage("This command cannot be run without setting 'zig.zls.path'.");
    return zlsPath !== null;
}

export async function activate(context: ExtensionContext) {
    outputChannel = window.createOutputChannel("Zig Language Server");

    vscode.commands.registerCommand("zig.zls.install", async () => {
        const zigPath = workspace.getConfiguration("zig").get<string | null>("path");
        if (zigPath === null) {
            window.showErrorMessage("This command cannot be run without setting 'zig.path'.");
            return;
        }

        await stopClient();
        await install(context, true);
    });

    vscode.commands.registerCommand("zig.zls.stop", async () => {
        if (!checkInstalled()) return;

        await stopClient();
    });

    vscode.commands.registerCommand("zig.zls.startRestart", async () => {
        if (!checkInstalled()) return;

        await stopClient();
        await startClient();
    });

    vscode.commands.registerCommand("zig.zls.openconfig", async () => {
        if (!checkInstalled()) return;

        await openConfig();
    });

    vscode.commands.registerCommand("zig.zls.update", async () => {
        if (!checkInstalled()) return;

        await stopClient();
        await checkUpdate(context);
        await startClient();
    });

    const zigConfig = vscode.workspace.getConfiguration("zig");
    if (zigConfig.get<string | null>("path") === null) return;
    const zlsConfig = workspace.getConfiguration("zig.zls");
    if (zlsConfig.get<string | null>("path") === null) return;
    if (zlsConfig.get<boolean>("checkForUpdate") && shouldCheckUpdate(context, "zlsUpdate")) {
        await checkUpdate(context);
    }
    await startClient();
}

export function deactivate(): Thenable<void> {
    return stopClient();
}
