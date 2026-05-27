/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as ts from 'typescript';
import { MoveSymbolRequest, MoveValidationResult } from './types';
import { TextMoveEngine } from './textMoveEngine';

interface JavaScriptMethodCallSite {
	callExpression: ts.CallExpression;
	propertyAccess: ts.PropertyAccessExpression;
	range: vscode.Range;
}

interface JavaScriptThisUsage {
	node: ts.ThisExpression;
	range: vscode.Range;
}

interface JavaScriptMethodMoveAnalysis {
	methodName: string;
	receiverParameterName: string;
	method: ts.MethodDeclaration;
	enclosingClass: ts.ClassLikeDeclaration;
	callSites: JavaScriptMethodCallSite[];
	thisUsages: JavaScriptThisUsage[];
	usesThis: boolean;
	allowed: boolean;
}

export class JavaScriptMethodExtractEngine extends TextMoveEngine {
	public analyzeMove(request: MoveSymbolRequest): JavaScriptMethodMoveAnalysis | MoveValidationResult {
		// validate safety
		if (request.document.languageId !== 'javascript') {
			return {
				allowed: false,
				reason: 'Only JavaScript files are supported for this refactoring right now.'
			};
		}

		if (request.sourceParent?.kind !== vscode.SymbolKind.Class) {
			return {
				allowed: false,
				reason: 'The selected method must be inside a class.'
			};
		}

		const basicMoveValidation = super.canMove(request);
		if (!basicMoveValidation.allowed) {
			return basicMoveValidation;
		}

		const sourceFile = ts.createSourceFile(
			request.document.fileName,
			request.document.getText(),
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.JS
		);

		const movedMethod = this.findMovedMethod(
			sourceFile,
			request.document,
			request.source.range
		);

		if (!movedMethod) {
			return {
				allowed: false,
				reason: 'Could not resolve the selected method in the syntax tree.'
			};
		}

		const { method, enclosingClass } = movedMethod;

		if (ts.isConstructorDeclaration(method)) {
			return {
				allowed: false,
				reason: 'Constructors cannot be moved out of a class yet.'
			};
		}

		if (ts.isGetAccessorDeclaration(method) || ts.isSetAccessorDeclaration(method)) {
			return {
				allowed: false,
				reason: 'Getters and setters cannot be moved out of a class yet.'
			};
		}

		if (ts.isPropertyDeclaration(method)) {
			return {
				allowed: false,
				reason: 'Class fields cannot be moved out of a class yet.'
			};
		}

		if (request.source.kind !== vscode.SymbolKind.Method) {
			return {
				allowed: false,
				reason: 'Only methods can be moved out of classes for now.'
			};
		}

		if (!ts.isMethodDeclaration(method)) {
			return {
				allowed: false,
				reason: 'Only class methods can be moved out of a class	for now.'
			};
		}

		if (!method.body) {
			return {
				allowed: false,
				reason: 'Methods without bodies cannot be moved yet.'
			};
		}

		if (ts.isPrivateIdentifier(method.name)) {
			return {
				allowed: false,
				reason: 'Private methods cannot be moved out of a class yet.'
			};
		}

		if (!ts.isIdentifier(method.name)) {
			return {
				allowed: false,
				reason: 'Only methods with simple identifier names can be moved for now.'
			};
		}

		if (this.containsPrivateIdentifier(method)) {
			return {
				allowed: false,
				reason: 'Methods that use private fields or private methods cannot be moved yet.'
			};
		}

		if (this.hasModifier(method, ts.SyntaxKind.StaticKeyword)) {
			return {
				allowed: false,
				reason: 'Static methods cannot be moved out of a class yet.'
			};
		}

		if (this.containsSuperKeyword(method)) {
			return {
				allowed: false,
				reason: 'Methods that use super cannot be moved out of a class yet.'
			};
		}

		if (this.containsDynamicThisAccess(method)) {
			return {
				allowed: false,
				reason: 'Methods with dynamic this[...] access cannot be moved safely for now.'
			};
		}

		const methodName = method.name.text;
		const callSiteValidation = this.validateCallSites(
			sourceFile,
			enclosingClass,
			method,
			methodName
		);

		if (!callSiteValidation.allowed) {
			return callSiteValidation;
		}

		const callSites = this.collectCallSites(
			enclosingClass,
			method,
			methodName,
			request.document
		);

		const thisUsages = this.collectThisUsages(
			method,
			request.document
		);

		const analysis: JavaScriptMethodMoveAnalysis = {
			methodName,
			receiverParameterName: 'obj',
			method,
			enclosingClass,
			callSites,
			thisUsages,
			usesThis: thisUsages.length > 0,
			allowed: true
		};

		return analysis;
	}

	public override canMove(request: MoveSymbolRequest): MoveValidationResult {
		const analysis = this.analyzeMove(request);

		if (!analysis.allowed) {
			return analysis;
		}

		return { allowed: true };
	}

	private collectCallSites(
		enclosingClass: ts.ClassLikeDeclaration,
		movedMethod: ts.MethodDeclaration,
		methodName: string,
		document: vscode.TextDocument
	): JavaScriptMethodCallSite[] {
		const callSites: JavaScriptMethodCallSite[] = [];

		const visit = (node: ts.Node): void => {
			// Do not record calls inside the moved method itself.
			if (node === movedMethod) {
				return;
			}

			if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
				const propertyAccess = node.expression;

				if (
					propertyAccess.expression.kind === ts.SyntaxKind.ThisKeyword &&
					propertyAccess.name.text === methodName
				) {
					callSites.push({
						callExpression: node,
						propertyAccess,
						range: this.nodeToRange(document, node)
					});
				}
			}

			ts.forEachChild(node, visit);
		};

		visit(enclosingClass);

		return callSites;
	}

	private collectThisUsages(
		method: ts.MethodDeclaration,
		document: vscode.TextDocument
	): JavaScriptThisUsage[] {
		const usages: JavaScriptThisUsage[] = [];

		const visit = (node: ts.Node): void => {
			if (node.kind === ts.SyntaxKind.ThisKeyword) {
				usages.push({
					node: node as ts.ThisExpression,
					range: this.nodeToRange(document, node)
				});
				return;
			}

			ts.forEachChild(node, visit);
		};

		if (method.body) {
			visit(method.body);
		}

		return usages;
	}

	private nodeToRange(
		document: vscode.TextDocument,
		node: ts.Node
	): vscode.Range {
		return new vscode.Range(
			document.positionAt(node.getStart()),
			document.positionAt(node.getEnd())
		);
	}

	private findMovedMethod(
		sourceFile: ts.SourceFile,
		document: vscode.TextDocument,
		sourceRange: vscode.Range
	): { method: ts.ClassElement; enclosingClass: ts.ClassLikeDeclaration } | undefined {
		const sourceStart = document.offsetAt(sourceRange.start);
		const sourceEnd = document.offsetAt(sourceRange.end);

		let bestMatch: { method: ts.ClassElement; enclosingClass: ts.ClassLikeDeclaration } | undefined;
		let bestMatchLength = Number.MAX_SAFE_INTEGER;

		const visit = (node: ts.Node): void => {
			if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
				for (const member of node.members) {
					const memberStart = member.getFullStart();
					const memberEnd = member.getEnd();

					if (memberStart <= sourceStart && sourceEnd <= memberEnd) {
						const memberLength = memberEnd - memberStart;
						if (memberLength < bestMatchLength) {
							bestMatch = {
								method: member,
								enclosingClass: node
							};
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

	private validateCallSites(
		sourceFile: ts.SourceFile,
		enclosingClass: ts.ClassLikeDeclaration,
		movedMethod: ts.MethodDeclaration,
		methodName: string
	): MoveValidationResult {
		let invalidReason: string | undefined;

		const visit = (node: ts.Node): void => {
			if (invalidReason) {
				return;
			}

			// Ignore the moved method body itself.
			if (node === movedMethod) {
				return;
			}

			if (ts.isPropertyAccessExpression(node) && node.name.text === methodName) {
				const isThisAccess = node.expression.kind === ts.SyntaxKind.ThisKeyword;
				const isDirectCall = ts.isCallExpression(node.parent) && node.parent.expression === node;
				const isInsideSourceClass = this.isNodeInside(node, enclosingClass);

				if (!isThisAccess || !isDirectCall || !isInsideSourceClass) {
					invalidReason = `Cannot safely rewrite all call sites for '${methodName}'.`;
					return;
				}
			}

			if (ts.isElementAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword) {
				invalidReason = 'Dynamic this[...] access prevents safe call-site analysis.';
				return;
			}

			ts.forEachChild(node, visit);
		};

		visit(sourceFile);

		if (invalidReason) {
			return {
				allowed: false,
				reason: invalidReason
			};
		}

		return { allowed: true };
	}

	private isNodeInside(node: ts.Node, parent: ts.Node): boolean {
		return parent.getFullStart() <= node.getFullStart() && node.getEnd() <= parent.getEnd();
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

	private containsDynamicThisAccess(node: ts.Node): boolean {
		let found = false;

		const visit = (child: ts.Node): void => {
			if (found) {
				return;
			}

			if (ts.isElementAccessExpression(child) && child.expression.kind === ts.SyntaxKind.ThisKeyword) {
				found = true;
				return;
			}

			ts.forEachChild(child, visit);
		};

		visit(node);
		return found;
	}
}
