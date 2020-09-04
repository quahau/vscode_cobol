'use strict';

import { commands, workspace, StatusBarItem, StatusBarAlignment, ExtensionContext, languages, TextDocument, Position, CancellationToken, ProviderResult, Definition, window, Hover, OutputChannel, extensions, tasks } from 'vscode';
import * as cobolProgram from './cobolprogram';
import * as tabstopper from './tabstopper';
import * as opencopybook from './opencopybook';
import * as commenter from './commenter';
import { DocComment } from './doccomment';
import { KeywordAutocompleteCompletionItemProvider } from './keywordprovider';
import { ESourceFormat, enableMarginCobolMargin, isEnabledViaWorkspace4cobol } from './margindecorations';

import { jclStatements } from "./keywords/jclstatements";
import { cobolKeywords } from "./keywords/cobolKeywords";

import { CobolDocumentSymbolProvider, JCLDocumentSymbolProvider } from './symbolprovider';
import * as sourcedefinitionprovider from './sourcedefinitionprovider';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from "vscode";

import updateDecorations from './margindecorations';
import { getCallTarget, CallTarget } from './keywords/cobolCallTargets';
import COBOLSourceScanner from './cobolsourcescanner';
import { InMemoryGlobalCachesHelper } from "./imemorycache";
import { isDirectPath, isNetworkPath } from './opencopybook';

import VSQuickCOBOLParse from './vscobolscanner';
import { VSCOBOLConfiguration } from './configuration';
import { CobolReferenceProvider } from './cobolreferenceprovider';
import { CobolLinterProvider, CobolLinterActionFixer } from './cobollinter';
import { SourceViewTree } from './sourceviewtree';
import { CobolSourceCompletionItemProvider } from './cobolprovider';
import { COBOLUtils, FoldStyle, FoldAction } from './cobolutils';
import { ICOBOLSettings } from './iconfiguration';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const propertiesReader = require('properties-reader');

import util from 'util';
import { getWorkspaceFolders } from './cobolfolders';
import { COBOLDocumentationGenerator } from './coboldocgenerator';

let formatStatusBarItem: StatusBarItem;

let currentContext: ExtensionContext;
const COBOLOutputChannel: OutputChannel = window.createOutputChannel("COBOL");


export function getCombinedCopyBookSearchPath(): string[] {
    return fileSearchDirectory;
}

export function isDirectory(sdir: string): boolean {
    try {
        const f = fs.statSync(sdir);
        if (f.isDirectory()) {
            return true;
        }
    }
    catch {
        return false;
    }
    return false;
}

export function isFile(sdir: string): boolean {
    try {
        const f = fs.statSync(sdir);
        if (f.isFile()) {
            return true;
        }
    }
    catch {
        return false;
    }
    return false;
}

let fileSearchDirectory: string[] = [];
let invalidSearchDirectory: string[] = [];
let unitTestTerminal: vscode.Terminal | undefined = undefined;
const terminalName = "UnitTest";


export function isPathInWorkspace(ddir: string): boolean {
    const ws = getWorkspaceFolders();
    if (workspace === undefined || ws === undefined) {
        return false;
    }

    const fullPath = path.normalize(ddir);
    for (const folder of ws) {
        if (folder.uri.fsPath === fullPath) {
            return true;
        }
    }

    return false;
}

function checkForExtensionConflicts(settings: ICOBOLSettings): string {
    let dupExtensionMessage = "";

    for (const ext of extensions.all) {
        if (ext !== undefined && ext.packageJSON !== undefined) {
            const contribuesWhat = ext.packageJSON.contributes;
            if (contribuesWhat !== undefined) {

                // dont include ourself in the check, may want to introduce a "blessed" list
                // of extensions at some point
                if (ext.packageJSON.publisher !== undefined && ext.packageJSON.publisher === 'bitlang') {
                    continue;
                }
                let grammarsBody = ext.packageJSON.contributes.grammars;
                if (grammarsBody !== undefined) {
                    if (grammarsBody instanceof Object) {
                        for (const key in grammarsBody) {
                            const element = grammarsBody[key];
                            if (element.language !== undefined) {
                                const l = `${element.language}`.toUpperCase();
                                if (l === 'COBOL') {
                                    let ext_info = ext;
                                    if (dupExtensionMessage.length === 0) {
                                        if (settings.ignore_unsafe_extensions === false) {
                                            dupExtensionMessage += "The COBOL Extension from bitlang may produce duplicate results due to\n";
                                            dupExtensionMessage += " other extensions for COBOL being present.\n\n";
                                            dupExtensionMessage += "If you do not want see this warning message, change the setting\n";
                                            dupExtensionMessage += " coboleditor.ignore_unsafe_extensions to true and restart vscode\n";
                                        }
                                    }
                                    dupExtensionMessage += `\nThe extension ${ext_info.packageJSON.name} from ${ext_info.packageJSON.publisher} has conflicting functionality\n`;

                                    if (ext_info.packageJSON.description !== undefined) {
                                        dupExtensionMessage += ` Description   : ${ext_info.packageJSON.description}\n`;
                                    }
                                    if (ext_info.packageJSON.version !== undefined) {
                                        dupExtensionMessage += ` Version       : ${ext_info.packageJSON.version}\n`;
                                    }

                                    if (ext_info.packageJSON.repository !== undefined && ext_info.packageJSON.repository.url !== undefined) {
                                        dupExtensionMessage += ` Repository    : ${ext_info.packageJSON.repository.url}\n`;
                                    }
                                    if (ext_info.packageJSON.bugs !== undefined && ext_info.packageJSON.bugs.url !== undefined) {
                                        dupExtensionMessage += ` Bug Reporting : ${ext_info.packageJSON.bugs.url}\n`;
                                    }
                                    if (ext_info.packageJSON.bugs !== undefined && ext_info.packageJSON.bugs.email !== undefined) {
                                        dupExtensionMessage += ` Bug Email     : ${ext_info.packageJSON.bugs.email}\n`;
                                    }

                                    if (dupExtensionMessage.length !== 0) {
                                        dupExtensionMessage += "\n";
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    return dupExtensionMessage;
}

let checkForExtensionConflictsMessage = "";
let messageBoxDone = false;
function initExtensionSearchPaths(config: ICOBOLSettings) {

    checkForExtensionConflictsMessage = checkForExtensionConflicts(config);
    if (checkForExtensionConflictsMessage.length !== 0 && config.ignore_unsafe_extensions === false && messageBoxDone === false) {
        messageBoxDone = true;
        window.showInformationMessage("COBOL Extension that has found duplicate functionality\n\nSee View->Output->COBOL for more information", { modal: true });
    }

    fileSearchDirectory.length = 0;

    const extsdir = VSCOBOLConfiguration.getCopybookdirs_defaults();
    invalidSearchDirectory = VSCOBOLConfiguration.getInvalid_copybookdirs();
    invalidSearchDirectory.length = 0;

    // step 1 look through the copybook default dirs for "direct" paths and include them in search path
    for (const ddir of extsdir) {
        if (config.disable_unc_copybooks_directories && isNetworkPath(ddir)) {
            logMessage(" Copybook directory " + ddir + " has been marked as invalid, as it is a unc filename");
            invalidSearchDirectory.push(ddir);
        }
        else if (isDirectPath(ddir)) {
            logMessage(` Warning: non portable copybook directory ${ddir} defined`);
            if (workspace !== undefined && getWorkspaceFolders() !== undefined) {
                if (isPathInWorkspace(ddir) === false) {
                    if (isNetworkPath(ddir)) {
                        logMessage(" The directory " + ddir + " for performance should be part of the workspace");
                    }
                }
            }

            const startTime = performance_now();
            if (isDirectory(ddir)) {
                const totalTimeInMS = performance_now() - startTime;
                const timeTaken = totalTimeInMS.toFixed(2);
                if (totalTimeInMS <= 2000) {
                    fileSearchDirectory.push(ddir);
                } else {
                    logMessage(" Slow copybook directory dropped " + ddir + " as it took " + timeTaken + "ms");
                    invalidSearchDirectory.push(ddir);
                }
            } else {
                invalidSearchDirectory.push(ddir);
            }
        }
    }

    // step 2
    const ws = getWorkspaceFolders();
    if (ws !== undefined) {
        for (const folder of ws) {
            // place the workspace folder in the copybook path

            fileSearchDirectory.push(folder.uri.fsPath);

            /* now add any extra directories that are below this workspace folder */
            for (const extdir of extsdir) {
                try {
                    if (isDirectPath(extdir) === false) {
                        const sdir = path.join(folder.uri.fsPath, extdir);

                        if (isDirectory(sdir)) {
                            if (isNetworkPath(sdir) && isPathInWorkspace(sdir) === false) {
                                logMessage(" The directory " + sdir + " for performance should be part of the workspace");
                            }

                            fileSearchDirectory.push(sdir);
                        } else {
                            invalidSearchDirectory.push(sdir);
                        }
                    }
                }
                catch (e) {
                    logException("dir", e);
                }
            }
        }
    }

    fileSearchDirectory = fileSearchDirectory.filter((elem, pos) => fileSearchDirectory.indexOf(elem) === pos);
    invalidSearchDirectory = invalidSearchDirectory.filter((elem, pos) => invalidSearchDirectory.indexOf(elem) === pos);
}

function activateLogChannelAndPaths(hide: boolean, settings: ICOBOLSettings) {
    if (hide) {
        COBOLOutputChannel.hide();
    } else {
        logChannelSetPreserveFocus(true);
    }
    COBOLOutputChannel.clear();

    const thisExtension = extensions.getExtension("bitlang.cobol");
    if (thisExtension !== undefined) {
        logMessage("VSCode version : " + vscode.version);
        logMessage("Extension Information:");
        logMessage(" Extension path    : " + thisExtension.extensionPath);
        logMessage(" Version           : " + thisExtension.packageJSON.version);

        if (VSCOBOLConfiguration.isCachingEnabled()) {
            logMessage(" Caching                       : " + VSCOBOLConfiguration.getCachingSetting());
            logMessage("  Cache Strategy               : " + VSCOBOLConfiguration.getCache_directory_strategy());
            logMessage("  Cache directory              : " + VSQuickCOBOLParse.getCacheDirectory());
            logMessage("  UNC paths disabled           : " + VSCOBOLConfiguration.getDisable_unc_copybooks());
        }
        logMessage(" Parse copybook for references : " + VSCOBOLConfiguration.getParse_copybooks_for_references());
    }

    initExtensionSearchPaths(settings);

    if (thisExtension !== undefined) {
        const ws = getWorkspaceFolders();
        if (ws !== undefined) {
            logMessage("  Workspace Folders:");
            for (const folder of ws) {
                logMessage("   => " + folder.name + " @ " + folder.uri.fsPath);
            }
        }

        let extsdir = getCombinedCopyBookSearchPath();
        if (extsdir.length !== 0) {
            logMessage("  Combined Workspace and CopyBook Folders to search:");
            for (const sdir of extsdir) {
                logMessage("   => " + sdir);
            }
        }

        extsdir = invalidSearchDirectory;
        if (extsdir.length !== 0) {
            logMessage("  Invalid CopyBook directories (" + extsdir.length + ")");
            for (const sdir of extsdir) {
                logMessage("   => " + sdir);
            }
        }

        logMessage("");
    }
}

export function getCurrentContext(): ExtensionContext {
    return currentContext;
}

function flip_plaintext(doc: TextDocument) {
    if (doc.languageId === 'plaintext') {
        const lcount = doc.lineCount;
        if (lcount >= 3) {
            const firstLine = doc.lineAt((0)).text;
            const secondLine = doc.lineAt(1).text;

            if ((firstLine.length >= 1 && firstLine.charCodeAt(0) === 12) && secondLine.startsWith("* Micro Focus COBOL ")) {
                vscode.languages.setTextDocumentLanguage(doc, "COBOL_LISTFILE");
                return;
            }
        }
    }
}


export function activate(context: ExtensionContext): void {
    currentContext = context;

    // re-init if something gets installed or removed
    const onExtChange = vscode.extensions.onDidChange(() => {
        const settings: ICOBOLSettings = VSCOBOLConfiguration.init();
        activateLogChannelAndPaths(true, settings);
    });
    context.subscriptions.push(onExtChange);


    const onDidChangeConfiguration = workspace.onDidChangeConfiguration(() => {
        const settings: ICOBOLSettings = VSCOBOLConfiguration.init();
        activateLogChannelAndPaths(true, settings);
    });
    context.subscriptions.push(onDidChangeConfiguration);

    const settings: ICOBOLSettings = VSCOBOLConfiguration.init();

    const collection = languages.createDiagnosticCollection('cobolDiag');
    const linter = new CobolLinterProvider(collection, VSCOBOLConfiguration.get());
    const cobolfixer = new CobolLinterActionFixer();
    initExtensionSearchPaths(settings);
    activateLogChannelAndPaths(true, settings);

    const insertIgnoreCommentLineCommand = commands.registerCommand("cobolplugin.insertIgnoreCommentLine", function (docUri: vscode.Uri, offset: number, code: string) {
        cobolfixer.insertIgnoreCommentLine(docUri, offset, code);
    });
    const move2pdCommand = commands.registerCommand('cobolplugin.move2pd', function () {
        cobolProgram.move2pd();
    });

    const move2ddCommand = commands.registerCommand('cobolplugin.move2dd', function () {
        cobolProgram.move2dd();
    });

    const move2wsCommand = commands.registerCommand('cobolplugin.move2ws', function () {
        cobolProgram.move2ws();
    });

    const move2anyforwardCommand = commands.registerCommand('cobolplugin.move2anyforward', function () {
        cobolProgram.move2anyforward();
    });

    const move2anybackwardsCommand = commands.registerCommand('cobolplugin.move2anybackwards', function () {
        cobolProgram.move2anybackwards();
    });

    const tabCommand = commands.registerCommand('cobolplugin.tab', function () {
        if (VSCOBOLConfiguration.isTabstopEnabled()) {
            tabstopper.processTabKey(true);
        } else {
            commands.executeCommand("tab");
        }
    });

    const unTabCommand = commands.registerCommand('cobolplugin.revtab', function () {
        if (VSCOBOLConfiguration.isTabstopEnabled()) {
            tabstopper.processTabKey(false);
        } else {
            commands.executeCommand("outdent");
        }
    });

    const commentLine = commands.registerCommand('cobolplugin.commentline', function () {
        if (window.activeTextEditor !== undefined) {
            const langid = window.activeTextEditor.document.languageId;

            if (langid === 'COBOL' || langid === 'OpenCOBOL' || langid === 'ACUCOBOL') {
                if (VSCOBOLConfiguration.isLineCommentEnabled()) {
                    commenter.processCommentLine();
                } else {
                    commands.executeCommand("editor.action.commentLine");
                }
            }
            return;
        }

        commands.executeCommand("editor.action.commentLine");
    });

    const changeSourceFormat = commands.registerCommand('cobolplugin.change_source_format', function () {
        // margindecorations.changeSourceFormat();
        const action = 'Open Settings';
        window.showWarningMessage("Change coboleditor setting?", action).then((selection) => {
            if (action === selection) {
                const ws = workspace.getWorkspaceFolder;
                if (ws === undefined || ws === null) {
                    commands.executeCommand("workbench.action.openGlobalSettings");
                }
                else {
                    commands.executeCommand("workbench.action.openWorkspaceSettings");
                }
            }
        });
    });

    const changeLanguageToAcu = commands.registerCommand('cobolplugin.change_lang_to_acu', function () {
        const act = window.activeTextEditor;
        if (act === null || act === undefined) {
            return;
        }

        languages.setTextDocumentLanguage(act.document, "ACUCOBOL");
    });

    const changeLanguageToCOBOL = commands.registerCommand('cobolplugin.change_lang_to_cobol', function () {
        const act = window.activeTextEditor;
        if (act === null || act === undefined) {
            return;
        }

        languages.setTextDocumentLanguage(act.document, "COBOL");
    });

    const changeLanguageToOpenCOBOL = commands.registerCommand('cobolplugin.change_lang_to_opencobol', function () {
        const act = window.activeTextEditor;
        if (act === null || act === undefined) {
            return;
        }

        languages.setTextDocumentLanguage(act.document, "OpenCOBOL");
    });

    const changeLanguageToGnuCOBOL = commands.registerCommand('cobolplugin.change_lang_to_gnucobol', function () {
        const act = window.activeTextEditor;
        if (act === null || act === undefined) {
            return;
        }

        languages.setTextDocumentLanguage(act.document, "GnuCOBOL");
    });

    const toggleCOBOLMargin = commands.registerCommand('cobolplugin.toggle_margin', function () {
        const act = window.activeTextEditor;
        if (act === null || act === undefined) {
            return;
        }

        enableMarginCobolMargin(!isEnabledViaWorkspace4cobol());
        updateDecorations(act);
    });

    const processAllFilesInWorkspace = commands.registerCommand('cobolplugin.processAllFilesInWorkspace', async () => {
        VSQuickCOBOLParse.processAllFilesInWorkspaces(true);
    });

    const dumpMetadata = commands.registerCommand('cobolplugin.dumpMetaData', function () {
        COBOLSourceScanner.dumpMetaData(VSCOBOLConfiguration.get(), VSQuickCOBOLParse.getCacheDirectory());
    });

    const clearMetaData = commands.registerCommand('cobolplugin.clearMetaData', function () {
        COBOLSourceScanner.clearMetaData(VSCOBOLConfiguration.get(), VSQuickCOBOLParse.getCacheDirectory());
    });


    const syntaxCheck = commands.registerCommand('cobolplugin.syntaxCheck', function () {
        tasks.fetchTasks().then((fetchedTasks) => {
            for (const task of fetchedTasks) {
                if (task.name.startsWith("cobol-syntax-check")) {
                    tasks.executeTask(task);
                }
            }
        }, (reason) => {
            logMessage(`Syntax check failed due to ${reason}`);
        });
    });

    const onDidChangeWorkspaceFolders = workspace.onDidChangeWorkspaceFolders(() => {
        const settings: ICOBOLSettings = VSCOBOLConfiguration.init();
        activateLogChannelAndPaths(false, settings);
    });
    context.subscriptions.push(onDidChangeWorkspaceFolders);

    // handle Micro Focus .lst files!
    const onDidOpenTextDocumentHandler = workspace.onDidOpenTextDocument((doc) => {
        flip_plaintext(doc);
    });
    context.subscriptions.push(onDidOpenTextDocumentHandler);

    /* flip any already opened docs */
    for (let docid = 0; docid < workspace.textDocuments.length; docid++) {
        flip_plaintext(workspace.textDocuments[docid]);
    }

    const treeView = new SourceViewTree(VSCOBOLConfiguration.get());
    const watcher = workspace.createFileSystemWatcher('**/*');

    watcher.onDidCreate((uri) => {
        treeView.checkFile(uri);
    });

    watcher.onDidDelete((uri) => {
        treeView.clearFile(uri);
    });

    window.registerTreeDataProvider('flat-source-view', treeView);

    context.subscriptions.push(move2pdCommand);
    context.subscriptions.push(move2ddCommand);
    context.subscriptions.push(move2wsCommand);
    context.subscriptions.push(move2anyforwardCommand);
    context.subscriptions.push(move2anybackwardsCommand);
    context.subscriptions.push(tabCommand);
    context.subscriptions.push(unTabCommand);
    context.subscriptions.push(commentLine);

    context.subscriptions.push(changeSourceFormat);

    context.subscriptions.push(changeLanguageToAcu);
    context.subscriptions.push(changeLanguageToCOBOL);
    context.subscriptions.push(changeLanguageToOpenCOBOL);
    context.subscriptions.push(changeLanguageToGnuCOBOL);

    context.subscriptions.push(toggleCOBOLMargin);

    context.subscriptions.push(processAllFilesInWorkspace);
    context.subscriptions.push(dumpMetadata);
    context.subscriptions.push(clearMetaData);

    context.subscriptions.push(DocComment.register());

    context.subscriptions.push(insertIgnoreCommentLineCommand);

    context.subscriptions.push(syntaxCheck);


    const allCobolSelectors = [
        { scheme: 'file', language: 'COBOL' },
        { scheme: 'file', language: 'ACUCOBOL' },
        { scheme: 'file', language: 'OpenCOBOL' },
        { scheme: 'file', language: 'GnuCOBOL' },
        { scheme: 'file', language: 'entcobol' }
    ];

    languages.registerDefinitionProvider(allCobolSelectors, {
        provideDefinition(doc: TextDocument, pos: Position, ct: CancellationToken): ProviderResult<Definition> {
            return opencopybook.provideDefinition(doc, pos, ct);
        }
    });

    languages.registerDefinitionProvider(allCobolSelectors, {
        provideDefinition(doc: TextDocument, pos: Position, ct: CancellationToken): ProviderResult<Definition> {
            return sourcedefinitionprovider.provideDefinition(doc, pos, ct);
        }
    });

    context.subscriptions.push(languages.registerReferenceProvider(allCobolSelectors, new CobolReferenceProvider()));
    context.subscriptions.push(languages.registerCodeActionsProvider(allCobolSelectors, cobolfixer));

    const jclSelectors = [
        { scheme: 'file', language: 'JCL' }
    ];
    const completionJCLItemProvider = new KeywordAutocompleteCompletionItemProvider(jclStatements, false);
    const completionJCLItemProviderDisposable = languages.registerCompletionItemProvider(jclSelectors, completionJCLItemProvider);
    context.subscriptions.push(completionJCLItemProviderDisposable);

    const keywordProvider = new KeywordAutocompleteCompletionItemProvider(cobolKeywords, true);
    const keywordProviderDisposible = languages.registerCompletionItemProvider(allCobolSelectors, keywordProvider);
    context.subscriptions.push(keywordProviderDisposible);

    if (VSCOBOLConfiguration.isOutlineEnabled()) {
        const jclDocumentSymbolProvider = new JCLDocumentSymbolProvider();
        context.subscriptions.push(languages.registerDocumentSymbolProvider(jclSelectors, jclDocumentSymbolProvider));

        /* TODO: add .DIR keywords too */
        const documentSymbolProvider = new CobolDocumentSymbolProvider();
        context.subscriptions.push(languages.registerDocumentSymbolProvider(allCobolSelectors, documentSymbolProvider));
    }

    /* hover provider */
    const cobolProvider = new CobolSourceCompletionItemProvider(VSCOBOLConfiguration.get());
    const cobolProviderDisposible = languages.registerCompletionItemProvider(allCobolSelectors, cobolProvider);
    context.subscriptions.push(cobolProviderDisposible);

    const disposable4hover_more_info = languages.registerHoverProvider(allCobolSelectors, {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        provideHover(document, position, token) {
            const txt = document.getText(document.getWordRangeAtPosition(position));
            const txtTarger: CallTarget | undefined = getCallTarget(txt);
            if (txtTarger !== undefined) {
                return new Hover("### " + txtTarger.api + "\n" + txtTarger.description + "\n\n#### [More information?](" + txtTarger.url + ")");
            }
        }
    });
    context.subscriptions.push(disposable4hover_more_info);

    window.onDidChangeActiveTextEditor(editor => {
        if (!editor) {
            return;
        }
        updateDecorations(editor);
        linter.updateLinter(editor.document);

    }, null, context.subscriptions);

    window.onDidChangeTextEditorSelection(event => {
        if (!event.textEditor) {
            return;
        }
        updateDecorations(event.textEditor);
        //cobolusage.updateDiagnostics(event.textEditor.document);
    }, null, context.subscriptions);

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    workspace.onDidChangeTextDocument(event => {
        if (!window.activeTextEditor) {
            return;
        }
        updateDecorations(window.activeTextEditor);
        linter.updateLinter(window.activeTextEditor.document);
    }, null, context.subscriptions);

    formatStatusBarItem = window.createStatusBarItem(StatusBarAlignment.Right);
    formatStatusBarItem.command = "cobolplugin.change_source_format";
    formatStatusBarItem.show();

    if (window.activeTextEditor !== undefined) {
        updateDecorations(window.activeTextEditor);
        linter.updateLinter(window.activeTextEditor.document);
    }

    // Open context menu on current file
    const disposable = vscode.commands.registerCommand('cobolplugin.mfurunMenu', function (fileUri) {

        if (unitTestTerminal === undefined) {
            unitTestTerminal = vscode.window.createTerminal(terminalName);
        }

        unitTestTerminal.show(true);
        const utils: COBOLUtils = new COBOLUtils();
        const enableAnsiColor = utils.getMFUnitAnsiColorConfig();

        const properties = propertiesReader(fileUri.fsPath);
        const prefRunner = properties.get('global.preferred-runner');
        unitTestTerminal.sendText(prefRunner + " -show-progress " +
            (enableAnsiColor ? " -dc:ansi " : " ") +
            fileUri.fsPath);
    });
    context.subscriptions.push(disposable);

    const removeAllCommentsCommand = vscode.commands.registerCommand('cobolplugin.removeAllComments', () => {
        if (vscode.window.activeTextEditor) {
            const langid = vscode.window.activeTextEditor.document.languageId;

            if (langid === 'COBOL' || langid === 'OpenCOBOL' || langid === 'ACUCOBOL') {
                const utils: COBOLUtils = new COBOLUtils();
                utils.RemoveComments(vscode.window.activeTextEditor);
            }
        }
    });
    context.subscriptions.push(removeAllCommentsCommand);

    const removeIdentificationAreaCommand = vscode.commands.registerCommand('cobolplugin.removeIdentificationArea', () => {
        if (vscode.window.activeTextEditor) {
            const langid = vscode.window.activeTextEditor.document.languageId;

            if (langid === 'COBOL' || langid === 'OpenCOBOL' || langid === 'ACUCOBOL') {
                const utils: COBOLUtils = new COBOLUtils();
                utils.RemoveIdentificationArea(vscode.window.activeTextEditor);
            }
        }
    });
    context.subscriptions.push(removeIdentificationAreaCommand);

    const removeColumnNumbersCommand = vscode.commands.registerCommand('cobolplugin.removeColumnNumbers', () => {
        if (vscode.window.activeTextEditor) {
            const langid = vscode.window.activeTextEditor.document.languageId;

            if (langid === 'COBOL' || langid === 'OpenCOBOL' || langid === 'ACUCOBOL') {
                const utils: COBOLUtils = new COBOLUtils();
                utils.removeColumnNumbers(vscode.window.activeTextEditor);
            }
        }
    });
    context.subscriptions.push(removeColumnNumbersCommand);


    const makeKeywordsLowercaseCommands = vscode.commands.registerCommand('cobolplugin.makeKeywordsLowercase', () => {
        if (vscode.window.activeTextEditor) {
            const langid = vscode.window.activeTextEditor.document.languageId;

            if (langid === 'COBOL' || langid === 'OpenCOBOL' || langid === 'ACUCOBOL') {
                const utils: COBOLUtils = new COBOLUtils();
                utils.foldToken(vscode.window.activeTextEditor, FoldAction.Keywords, FoldStyle.LowerCase);
            }
        }
    });
    context.subscriptions.push(makeKeywordsLowercaseCommands);

    const makeKeywordsUppercaseCommands = vscode.commands.registerCommand('cobolplugin.makeKeywordsUppercase', () => {
        if (vscode.window.activeTextEditor) {
            const langid = vscode.window.activeTextEditor.document.languageId;

            if (langid === 'COBOL' || langid === 'OpenCOBOL' || langid === 'ACUCOBOL') {
                const utils: COBOLUtils = new COBOLUtils();
                utils.foldToken(vscode.window.activeTextEditor, FoldAction.Keywords, FoldStyle.UpperCase);
            }
        }
    });
    context.subscriptions.push(makeKeywordsUppercaseCommands);

    const makeKeywordsCamelCaseCommands = vscode.commands.registerCommand('cobolplugin.makeKeywordsCamelCase', () => {
        if (vscode.window.activeTextEditor) {
            const langid = vscode.window.activeTextEditor.document.languageId;

            if (langid === 'COBOL' || langid === 'OpenCOBOL' || langid === 'ACUCOBOL') {
                const utils: COBOLUtils = new COBOLUtils();
                utils.foldToken(vscode.window.activeTextEditor, FoldAction.Keywords, FoldStyle.CamelCase);
            }
        }
    });
    context.subscriptions.push(makeKeywordsCamelCaseCommands);

    const makeFieldsLowercaseCommand = vscode.commands.registerCommand('cobolplugin.makeFieldsLowercase', () => {
        if (vscode.window.activeTextEditor) {
            const langid = vscode.window.activeTextEditor.document.languageId;

            if (langid === 'COBOL' || langid === 'OpenCOBOL' || langid === 'ACUCOBOL') {
                const utils: COBOLUtils = new COBOLUtils();
                utils.foldToken(vscode.window.activeTextEditor, FoldAction.ConstantsOrVariables, FoldStyle.UpperCase);
            }
        }
    });
    context.subscriptions.push(makeFieldsLowercaseCommand);

    const makeFieldsUppercaseCommand = vscode.commands.registerCommand('cobolplugin.makeFieldsUppercase', () => {
        if (vscode.window.activeTextEditor) {
            const langid = vscode.window.activeTextEditor.document.languageId;

            if (langid === 'COBOL' || langid === 'OpenCOBOL' || langid === 'ACUCOBOL') {
                const utils: COBOLUtils = new COBOLUtils();
                utils.foldToken(vscode.window.activeTextEditor, FoldAction.ConstantsOrVariables, FoldStyle.UpperCase);
            }
        }
    });
    context.subscriptions.push(makeFieldsUppercaseCommand);

    const makeFieldsCamelCaseCommand = vscode.commands.registerCommand('cobolplugin.makeFieldsCamelCase', () => {
        if (vscode.window.activeTextEditor) {
            const langid = vscode.window.activeTextEditor.document.languageId;

            if (langid === 'COBOL' || langid === 'OpenCOBOL' || langid === 'ACUCOBOL') {
                const utils: COBOLUtils = new COBOLUtils();
                utils.foldToken(vscode.window.activeTextEditor, FoldAction.ConstantsOrVariables, FoldStyle.CamelCase);
            }
        }
    });
    context.subscriptions.push(makeFieldsCamelCaseCommand);

    const makePerformTargetsLowerCaseCommand = vscode.commands.registerCommand('cobolplugin.makePerformTargetsLowerCase', () => {
        if (vscode.window.activeTextEditor) {
            const langid = vscode.window.activeTextEditor.document.languageId;

            if (langid === 'COBOL' || langid === 'OpenCOBOL' || langid === 'ACUCOBOL') {
                const utils: COBOLUtils = new COBOLUtils();
                utils.foldToken(vscode.window.activeTextEditor, FoldAction.PerformTargets, FoldStyle.LowerCase);
            }
        }
    });
    context.subscriptions.push(makePerformTargetsLowerCaseCommand);

    const makePerformTargetsUpperCaseCommand = vscode.commands.registerCommand('cobolplugin.makePerformTargetsUpperCase', () => {
        if (vscode.window.activeTextEditor) {
            const langid = vscode.window.activeTextEditor.document.languageId;

            if (langid === 'COBOL' || langid === 'OpenCOBOL' || langid === 'ACUCOBOL') {
                const utils: COBOLUtils = new COBOLUtils();
                utils.foldToken(vscode.window.activeTextEditor, FoldAction.PerformTargets, FoldStyle.UpperCase);
            }
        }
    });
    context.subscriptions.push(makePerformTargetsUpperCaseCommand);

    const makePerformTargetsCamelCaseCommand = vscode.commands.registerCommand('cobolplugin.makePerformTargetsCamelCase', () => {
        if (vscode.window.activeTextEditor) {
            const langid = vscode.window.activeTextEditor.document.languageId;

            if (langid === 'COBOL' || langid === 'OpenCOBOL' || langid === 'ACUCOBOL') {
                const utils: COBOLUtils = new COBOLUtils();
                utils.foldToken(vscode.window.activeTextEditor, FoldAction.PerformTargets, FoldStyle.CamelCase);
            }
        }
    });
    context.subscriptions.push(makePerformTargetsCamelCaseCommand);

    const extractSelectionToParagraphCommand = vscode.commands.registerCommand('cobolplugin.extractSelectionToParagraph', () => {
        if (vscode.window.activeTextEditor) {
            const langid = vscode.window.activeTextEditor.document.languageId;

            if (langid === 'COBOL' || langid === 'OpenCOBOL' || langid === 'ACUCOBOL') {
                const utils: COBOLUtils = new COBOLUtils();
                utils.extractSelectionTo(vscode.window.activeTextEditor, true);
            }
        }
    });
    context.subscriptions.push(extractSelectionToParagraphCommand);

    const extractSelectionToSectionCommand = vscode.commands.registerCommand('cobolplugin.extractSelectionToSection', () => {
        if (vscode.window.activeTextEditor) {
            const langid = vscode.window.activeTextEditor.document.languageId;

            if (langid === 'COBOL' || langid === 'OpenCOBOL' || langid === 'ACUCOBOL') {
                const utils: COBOLUtils = new COBOLUtils();
                utils.extractSelectionTo(vscode.window.activeTextEditor, false);
            }
        }
    });
    context.subscriptions.push(extractSelectionToSectionCommand);


    const extractSelectionToCopybookCommand = vscode.commands.registerCommand('cobolplugin.extractSelectionToCopybook', () => {
        if (vscode.window.activeTextEditor) {
            const langid = vscode.window.activeTextEditor.document.languageId;

            if (langid === 'COBOL' || langid === 'OpenCOBOL' || langid === 'ACUCOBOL') {
                const utils: COBOLUtils = new COBOLUtils();
                utils.extractSelectionToCopybook(vscode.window.activeTextEditor);
            }
        }
    });
    context.subscriptions.push(extractSelectionToCopybookCommand);

    const showDocumentationCommand = vscode.commands.registerCommand('cobolplugin.showDocumentation', () => {
        if (vscode.window.activeTextEditor) {
            const langid = vscode.window.activeTextEditor.document.languageId;

            if (langid === 'COBOL' || langid === 'OpenCOBOL' || langid === 'ACUCOBOL') {
                COBOLDocumentationGenerator.showCOBOLDOCDocumentation(vscode.window.activeTextEditor, settings);
            }
        }
    });
    context.subscriptions.push(showDocumentationCommand);

    const generateCOBOLSourceTagCommand = vscode.commands.registerCommand('cobolplugin.generateSourceTag', () => {
        if (vscode.window.activeTextEditor) {
            const langid = vscode.window.activeTextEditor.document.languageId;

            if (langid === 'COBOL' || langid === 'OpenCOBOL' || langid === 'ACUCOBOL') {
                COBOLDocumentationGenerator.generateCOBOLSourceTag(vscode.window.activeTextEditor, settings);
            }
        }
    });
    context.subscriptions.push(generateCOBOLSourceTagCommand);


    const migrateCopybooksToWorkspaceCommand = vscode.commands.registerCommand('cobolplugin.migrateCopybooksToWorkspace', () => {
        const utils: COBOLUtils = new COBOLUtils();
        utils.migrateCopybooksToWorkspace();
    });
    context.subscriptions.push(migrateCopybooksToWorkspaceCommand);

    const resequenceColumnNumbersCommands = vscode.commands.registerCommand('cobolplugin.resequenceColumnNumbers', () => {
        if (vscode.window.activeTextEditor) {
            const langid = vscode.window.activeTextEditor.document.languageId;

            if (langid === 'COBOL' || langid === 'OpenCOBOL' || langid === 'ACUCOBOL') {

                vscode.window.showInputBox({
                    prompt: 'Enter start line number and increment',
                    validateInput: (text: string): string | undefined => {
                        if (!text || text.indexOf(' ') === -1) {
                            return 'You must enter two numbers';
                        } else {
                            return undefined;
                        }
                    }
                }).then(value => {
                    // leave early
                    if (value === undefined) {
                        return;
                    }
                    const values: string[] = value.split(" ");
                    const startValue: number = Number.parseInt(values[0]);
                    const incrementValue: number = Number.parseInt(values[1]);
                    if (startValue >= 0 && incrementValue >= 1) {
                        const utils: COBOLUtils = new COBOLUtils();
                        utils.resequenceColumnNumbers(vscode.window.activeTextEditor, startValue, incrementValue);
                    } else {
                        vscode.window.showErrorMessage("Sorry invalid re-sequence given");
                    }
                });
            }
        }
    });
    context.subscriptions.push(resequenceColumnNumbersCommands);

    /* load the cache if we can */
    const cacheDirectory = VSQuickCOBOLParse.getCacheDirectory();
    if (cacheDirectory !== null && cacheDirectory.length > 0) {
        InMemoryGlobalCachesHelper.loadInMemoryGlobalSymbolCaches(cacheDirectory);
        InMemoryGlobalCachesHelper.loadInMemoryGlobalFileCache(cacheDirectory);
    }

    if (checkForExtensionConflictsMessage.length !== 0) {
        logMessage(checkForExtensionConflictsMessage);
    }

    if (VSCOBOLConfiguration.get().process_metadata_cache_on_start) {
        const pm_cache_promise = async () => {
            VSQuickCOBOLParse.processAllFilesInWorkspaces(false);
        };
        pm_cache_promise();
    }

}

export function enableMarginStatusBar(formatStyle: ESourceFormat): void {
    formatStatusBarItem.text = "Source:" + formatStyle.toString();
    formatStatusBarItem.show();
}


export function hideMarginStatusBar(): void {
    formatStatusBarItem.hide();
}

export async function deactivateAsync(): Promise<void> {
    if (VSCOBOLConfiguration.isCachingEnabled()) {
        InMemoryGlobalCachesHelper.saveInMemoryGlobalCaches(VSQuickCOBOLParse.getCacheDirectory());
        formatStatusBarItem.dispose();
    }
}

export async function deactivate(): Promise<void> {
    await deactivateAsync();
}

export function logException(message: string, ex: Error): void {
    logMessage(ex.name + ":" + message);
    if (ex !== undefined && ex.stack !== undefined) {
        logMessage(ex.stack);
    }
}

export const logTimeThreshold = 500;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function logTimedMessage(timeTaken: number, message: string, ...parameters: any[]): boolean {
    const fixedTimeTaken = " (" + timeTaken.toFixed(2) + "ms)";

    if (timeTaken < logTimeThreshold) {
        return false;
    }

    if ((parameters !== undefined || parameters !== null) && parameters.length !== 0) {
        const m: string = util.format(message, parameters);
        COBOLOutputChannel.appendLine(m.padEnd(60) + fixedTimeTaken);
    } else {
        COBOLOutputChannel.appendLine(message.padEnd(60) + fixedTimeTaken);
    }

    return true;
}


// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function logMessage(message: string, ...parameters: any[]): void {
    if ((parameters !== undefined || parameters !== null) && parameters.length !== 0) {
        COBOLOutputChannel.appendLine(util.format(message, parameters));
    } else {
        COBOLOutputChannel.appendLine(message);
    }
}

export function logChannelSetPreserveFocus(preserveFocus: boolean): void {
    COBOLOutputChannel.show(preserveFocus);
}

export function logChannelHide(): void {
    COBOLOutputChannel.hide();
}

export function performance_now(): number {
    if (!process.env.BROWSER) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            return require('performance-now').performance.now;
        }
        catch {
            return Date.now();
        }
    }

    return Date.now();
}