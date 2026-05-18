/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { MoveSymbolRequest, SymbolMoveEngine } from './types';

export class TextMoveEngine implements SymbolMoveEngine {
	public canMove(request: MoveSymbolRequest): boolean {
		const sourceRange = this.expandToWholeLines(
			request.document,
			request.source.range
		);

		const targetRange = this.expandToWholeLines(
			request.document,
			request.target.range
		);

		// Prevent moving a symbol into itself.
		if (
			sourceRange.contains(targetRange.start) ||
			sourceRange.contains(targetRange.end)
		) {
			return false;
		}

		return true;
	}

	public buildEdit(request: MoveSymbolRequest): vscode.WorkspaceEdit | undefined {
		const { document, source, target, dropPosition } = request;

		const sourceRange = this.expandToWholeLines(document, source.range);
		const targetRange = this.expandToWholeLines(document, target.range);

		const originalText = document.getText();

		const sourceStart = document.offsetAt(sourceRange.start);
		const sourceEnd = document.offsetAt(sourceRange.end);

		const targetStart = document.offsetAt(targetRange.start);
		const targetEnd = document.offsetAt(targetRange.end);

		const movedText = originalText.slice(sourceStart, sourceEnd);

		const textWithoutSource =
			originalText.slice(0, sourceStart) +
			originalText.slice(sourceEnd);

		const removedLength = sourceEnd - sourceStart;

		let insertionOffset: number;

		if (dropPosition === 'before') {
			insertionOffset =
				targetStart > sourceStart
					? targetStart - removedLength
					: targetStart;
		} else {
			insertionOffset =
				targetEnd > sourceStart
					? targetEnd - removedLength
					: targetEnd;
		}

		const newText =
			textWithoutSource.slice(0, insertionOffset) +
			movedText +
			textWithoutSource.slice(insertionOffset);

		const edit = new vscode.WorkspaceEdit();

		const fullDocumentRange = new vscode.Range(
			document.positionAt(0),
			document.positionAt(originalText.length)
		);

		edit.replace(document.uri, fullDocumentRange, newText);

		return edit;
	}

	private expandToWholeLines(
		document: vscode.TextDocument,
		range: vscode.Range
	): vscode.Range {
		const start = new vscode.Position(range.start.line, 0);

		const endLine =
			range.end.character === 0
				? range.end.line
				: range.end.line + 1;

		if (endLine < document.lineCount) {
			return new vscode.Range(
				start,
				new vscode.Position(endLine, 0)
			);
		}

		return new vscode.Range(
			start,
			document.lineAt(document.lineCount - 1).rangeIncludingLineBreak.end
		);
	}
}
