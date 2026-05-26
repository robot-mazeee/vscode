/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as ts from 'typescript';
import { MoveSymbolRequest, MoveValidationResult, SymbolMoveEngine } from './types';

export class TextMoveEngine implements SymbolMoveEngine {
	public canMove(request: MoveSymbolRequest): MoveValidationResult {

		// For our initial implementation, we only support moving JavaScript methods outside of their classes
		if (request.document.languageId !== 'javascript') {
			return { allowed: false };
		}

		// Only allow moving methods outside of their classes
		if (request.source.kind !== vscode.SymbolKind.Method || request.target.kind === vscode.SymbolKind.Class) {
			return { allowed: false };
		}

		const sourceRange = this.expandToWholeLines(
			request.document,
			request.source.range
		);
		const targetRange = this.expandToWholeLines(
			request.document,
			request.target.range
		);

		// Prevent moving a symbol into itself
		if (sourceRange.contains(targetRange.start) || sourceRange.contains(targetRange.end)) {
			return { allowed: false };
		}

		const sourceFile = ts.createSourceFile(
			request.document.fileName,
			request.document.getText(),
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.JS
		);

		// Find the class element being moved and check if it's a method that can be moved outside of its class
		const member = this.findMovedClassElement(sourceFile, request.document, request.source.range);
		if (!member) {
			return { allowed: false };
		}

		// Constructors cannot be moved out of their classes
		if (ts.isConstructorDeclaration(member)) {
			return { allowed: false, reason: 'Constructors cannot be moved out of a class.' };
		}

		// Getters and setters cannot be moved out of their classes
		if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
			return { allowed: false, reason: 'Getters and setters cannot be moved out of a class.' };
		}

		// Ensure the moved member is a method, as we currently only support moving methods outside of their classes
		// From here on we can safely cast it and perform method-specific checks
		if (!ts.isMethodDeclaration(member)) {
			return { allowed: false };
		}

		// Methods with computed names cannot be moved outside of their classes
		if (ts.isComputedPropertyName(member.name)) {
			return { allowed: false, reason: 'Methods with computed names cannot be moved yet.' };
		}

		// Static methods cannot be moved outside of their classes
		if (this.hasModifier(member, ts.SyntaxKind.StaticKeyword)) {
			return { allowed: false, reason: 'Static methods cannot be moved out of a class yet.' };
		}

		// Methods that use private class fields or methods cannot be moved outside of their classes
		if (this.containsPrivateIdentifier(member)) {
			return { allowed: false, reason: 'Methods that use private class fields or methods cannot be moved yet.' };
		}

		// Methods that use super cannot be moved outside of their classes
		if (this.containsSuperKeyword(member)) {
			return { allowed: false, reason: 'Methods that use super cannot be moved out of a class.' };
		}

		return { allowed: true };
	}

	// Finds the class element that corresponds to the symbol being moved
	private findMovedClassElement(
		sourceFile: ts.SourceFile,
		document: vscode.TextDocument,
		sourceRange: vscode.Range
	): ts.ClassElement | undefined {

		const sourceStart = document.offsetAt(sourceRange.start);
		const sourceEnd = document.offsetAt(sourceRange.end);

		let bestMatch: ts.ClassElement | undefined;
		let bestMatchLength = Number.MAX_SAFE_INTEGER;

		const visit = (node: ts.Node): void => {
			if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
				for (const member of node.members) {
					const memberStart = member.getFullStart();
					const memberEnd = member.getEnd();

					if (memberStart <= sourceStart && sourceEnd <= memberEnd) {
						const memberLength = memberEnd - memberStart;
						if (memberLength < bestMatchLength) {
							bestMatch = member;
							bestMatchLength = memberLength;
						}
					}
				}
			}

			ts.forEachChild(node, visit);
		};

		visit(sourceFile);
		return bestMatch;
	}

	private hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
		return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === kind) === true;
	}

	private containsPrivateIdentifier(node: ts.Node): boolean {
		let found = false;

		const visit = (child: ts.Node): void => {
			if (found) {
				return;
			}

			if (ts.isPrivateIdentifier(child)) {
				found = true;
				return;
			}

			ts.forEachChild(child, visit);
		};

		visit(node);
		return found;
	}

	private containsSuperKeyword(node: ts.Node): boolean {
		let found = false;

		const visit = (child: ts.Node): void => {
			if (found) {
				return;
			}

			if (child.kind === ts.SyntaxKind.SuperKeyword) {
				found = true;
				return;
			}

			ts.forEachChild(child, visit);
		};

		visit(node);
		return found;
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

		const movedText = this.outdentMovedText(originalText.slice(sourceStart, sourceEnd));

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

	// used for outdenting the moved method so that it fits better in the new location
	private outdentMovedText(text: string): string {
		const eol = text.includes('\r\n') ? '\r\n' : '\n';
		const hasFinalEol = text.endsWith('\n');
		const lines = text.split(/\r\n|\r|\n/);

		if (hasFinalEol) {
			lines.pop();
		}

		const firstCodeLine = lines.find(line => line.trim().length > 0);
		const indent = firstCodeLine?.match(/^\s*/)?.[0] ?? '';

		if (!indent) {
			return text;
		}

		const outdented = lines.map(line =>
			line.startsWith(indent) ? line.slice(indent.length) : line
		);

		return outdented.join(eol) + (hasFinalEol ? eol : '');
	}
}



