
import * as vscode from 'vscode';
import { VSCodeSourceHandler } from './VSCodeSourceHandler';
import COBOLQuickParse, { SharedSourceReferences } from './cobolquickparse';
import { VSCOBOLConfiguration } from './configuration';
import { CodeActionProvider, CodeAction } from 'vscode';

export class CobolUsageActionFixer implements CodeActionProvider {
    provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext, token: vscode.CancellationToken): vscode.ProviderResult<(vscode.Command | vscode.CodeAction)[]> {
        const codeActions: CodeAction[] = [];
        for (const diagnostic of context.diagnostics) {
            if (diagnostic.code !== undefined && diagnostic.code.toString().startsWith("noref") === false) {
                continue;
            }
            codeActions.push({
                title: `Comment out '${diagnostic.message}'`,
                diagnostics: [diagnostic],
                command: {
                    title: 'Comment out',
                    command: "editor.action.addCommentLine",
                    arguments: [document.uri, document.offsetAt(diagnostic.range.start), diagnostic.code],
                },
                kind: vscode.CodeActionKind.QuickFix,
            });
        }
        return codeActions;
    }
}

export class CobolUsageProvider {
    private enabled: boolean = false;

    private collection: vscode.DiagnosticCollection;
    private diagCollect: vscode.DiagnosticSeverity;

    constructor(collection: vscode.DiagnosticCollection, enabled: boolean) {
        this.collection = collection;
        this.enabled = enabled;
        this.diagCollect = vscode.DiagnosticSeverity.Information;
    }



    public updateDiagnostics(document: vscode.TextDocument, ): void {
        if (this.enabled === false) {
            return;
        }

        this.setupCOBOLQuickParse(document);

        if (this.sourceRefs === undefined || this.current === undefined) {
            return;
        }

        let qp: COBOLQuickParse = this.current;
        let sourceRefs: SharedSourceReferences = this.sourceRefs;

        let diagRefs = new Map<string, vscode.Diagnostic[]>();
        this.collection.clear();

        for (let [key, token] of qp.paragraphs) {
            let workLower = key.toLowerCase();
            if (sourceRefs.targetReferences.has(workLower) === false) {
                let r = new vscode.Range(new vscode.Position(token.startLine, token.startColumn),
                    new vscode.Position(token.startLine, token.startColumn + token.tokenName.length));
                let d = new vscode.Diagnostic(r, key + ' paragraph is not referenced', this.diagCollect);
                d.code ="noref("+key+")";

                if (diagRefs.has(token.filename)) {
                    let arr = diagRefs.get(token.filename);
                    if (arr !== undefined) {
                        arr.push(d);
                    }
                } else {
                    let arr: vscode.Diagnostic[] = [];
                    arr.push(d);
                    diagRefs.set(token.filename, arr);
                }
            }
        }

        for (let [key, token] of qp.sections) {
            let workLower = key.toLowerCase();
            if (token.inProcedureDivision) {
                if (sourceRefs.targetReferences.has(workLower) === false) {
                    let r = new vscode.Range(new vscode.Position(token.startLine, token.startColumn),
                        new vscode.Position(token.startLine, token.startColumn + token.tokenName.length));
                    let d = new vscode.Diagnostic(r, key + ' section is not referenced', this.diagCollect);
                    d.code ="noref("+key+")";

                    if (diagRefs.has(token.filename)) {
                        let arr = diagRefs.get(token.filename);
                        if (arr !== undefined) {
                            arr.push(d);
                        }
                    } else {
                        let arr: vscode.Diagnostic[] = [];
                        arr.push(d);
                        diagRefs.set(token.filename, arr);
                    }
                }
            }

        }


        for (let [f, value] of diagRefs) {
            let u = vscode.Uri.file(f);
            this.collection.set(u, value);
        }
    }

    private current?: COBOLQuickParse;
    private currentVersion?: number;
    private sourceRefs?: SharedSourceReferences;


    private setupCOBOLQuickParse(document: vscode.TextDocument) {
        if (this.current !== undefined && this.current.filename !== document.fileName) {
            this.current = undefined;
        }

        // cache current document, interatives search to be faster
        if (this.current === undefined || this.currentVersion !== document.version) {
            let file = new VSCodeSourceHandler(document, false);
            this.sourceRefs = new SharedSourceReferences();
            this.current = new COBOLQuickParse(file, document.fileName, VSCOBOLConfiguration.get(), "", this.sourceRefs);
            this.currentVersion = document.version;
        }

    }
}