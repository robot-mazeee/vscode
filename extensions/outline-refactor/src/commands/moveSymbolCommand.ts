/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { TextMoveEngine } from '../refactor/textMoveEngine';
import { DropPosition, MoveSymbolRequest } from '../refactor/types';

interface SerializedRange {
	start: {
		line: number;
		character: number;
	};
	end: {
		line: number;
		character: number;
	};
}

interface SerializedOutlineMoveSymbol {
	name: string;
	kind: number;
	range: SerializedRange;
}

interface MoveSymbolCommandArgs {
	uri: vscode.Uri;
	source: SerializedOutlineMoveSymbol;
	target: SerializedOutlineMoveSymbol;
	position: DropPosition;
}

function reviveRange(range: SerializedRange): vscode.Range {
	return new vscode.Range(
		new vscode.Position(range.start.line, range.start.character),
		new vscode.Position(range.end.line, range.end.character)
	);
}

export function registerMoveSymbolCommand(
	context: vscode.ExtensionContext
): void {
	const disposable = vscode.commands.registerCommand(
		'outline.moveSymbol',
		async (args: MoveSymbolCommandArgs) => {
			const document = await vscode.workspace.openTextDocument(args.uri);

			const request: MoveSymbolRequest = {
				document,
				source: {
					name: args.source.name,
					kind: args.source.kind,
					range: reviveRange(args.source.range)
				},
				target: {
					name: args.target.name,
					kind: args.target.kind,
					range: reviveRange(args.target.range)
				},
				dropPosition: args.position
			};

			const engine = new TextMoveEngine();
			const validation = engine.canMove(request);

			if (!validation.allowed) {
				if (validation.reason) {
					vscode.window.showWarningMessage(validation.reason);
				}
				return;
			}

			const edit = engine.buildEdit(request);

			if (!edit) {
				vscode.window.showErrorMessage(
					'Could not build the symbol move edit.'
				);
				return;
			}

			const applied = await vscode.workspace.applyEdit(edit);

			if (!applied) {
				vscode.window.showErrorMessage(
					'Failed to apply the symbol move.'
				);
			}
		}
	);

	context.subscriptions.push(disposable);
}
