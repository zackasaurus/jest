/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {PluginObj} from '@babel/core';
import {statement} from '@babel/template';
import type {NodePath} from '@babel/traverse';
import {
  BlockStatement,
  CallExpression,
  Expression,
  Identifier,
  Node,
  Program,
  VariableDeclaration,
  VariableDeclarator,
  callExpression,
  emptyStatement,
  isIdentifier,
  variableDeclaration,
} from '@babel/types';

const JEST_GLOBAL_NAME = 'jest';
const JEST_GLOBALS_MODULE_NAME = '@jest/globals';
const JEST_GLOBALS_MODULE_JEST_EXPORT_NAME = 'jest';

const hoistedVariables = new WeakSet<VariableDeclarator>();

// We allow `jest`, `expect`, `require`, all default Node.js globals and all
// ES2015 built-ins to be used inside of a `jest.mock` factory.
// We also allow variables prefixed with `mock` as an escape-hatch.
const ALLOWED_IDENTIFIERS = new Set<string>(
  [
    'Array',
    'ArrayBuffer',
    'Boolean',
    'BigInt',
    'DataView',
    'Date',
    'Error',
    'EvalError',
    'Float32Array',
    'Float64Array',
    'Function',
    'Generator',
    'GeneratorFunction',
    'Infinity',
    'Int16Array',
    'Int32Array',
    'Int8Array',
    'InternalError',
    'Intl',
    'JSON',
    'Map',
    'Math',
    'NaN',
    'Number',
    'Object',
    'Promise',
    'Proxy',
    'RangeError',
    'ReferenceError',
    'Reflect',
    'RegExp',
    'Set',
    'String',
    'Symbol',
    'SyntaxError',
    'TypeError',
    'URIError',
    'Uint16Array',
    'Uint32Array',
    'Uint8Array',
    'Uint8ClampedArray',
    'WeakMap',
    'WeakSet',
    'arguments',
    'console',
    'expect',
    'isNaN',
    'jest',
    'parseFloat',
    'parseInt',
    'exports',
    'require',
    'module',
    '__filename',
    '__dirname',
    'undefined',
    ...Object.getOwnPropertyNames(global),
  ].sort(),
);

const IDVisitor = {
  ReferencedIdentifier(
    path: NodePath<Identifier>,
    {ids}: {ids: Set<NodePath<Identifier>>},
  ) {
    ids.add(path);
  },
  blacklist: ['TypeAnnotation', 'TSTypeAnnotation', 'TSTypeReference'],
};

const FUNCTIONS: Record<
  string,
  <T extends Node>(args: Array<NodePath<T>>) => boolean
> = Object.create(null);

FUNCTIONS.mock = args => {
  if (args.length === 1) {
    return args[0].isStringLiteral() || args[0].isLiteral();
  } else if (args.length === 2 || args.length === 3) {
    const moduleFactory = args[1];

    if (!moduleFactory.isFunction()) {
      throw moduleFactory.buildCodeFrameError(
        'The second argument of `jest.mock` must be an inline function.\n',
        TypeError,
      );
    }

    const ids: Set<NodePath<Identifier>> = new Set();
    const parentScope = moduleFactory.parentPath.scope;
    // @ts-expect-error: ReferencedIdentifier and blacklist are not known on visitors
    moduleFactory.traverse(IDVisitor, {ids});
    for (const id of ids) {
      const {name} = id.node;
      let found = false;
      let scope = id.scope;

      while (scope !== parentScope) {
        if (scope.bindings[name]) {
          found = true;
          break;
        }

        scope = scope.parent;
      }

      if (!found) {
        let isAllowedIdentifier =
          (scope.hasGlobal(name) && ALLOWED_IDENTIFIERS.has(name)) ||
          /^mock/i.test(name) ||
          // Allow istanbul's coverage variable to pass.
          /^(?:__)?cov/.test(name);

        if (!isAllowedIdentifier) {
          const binding = scope.bindings[name];

          if (binding?.path.isVariableDeclarator()) {
            const {node} = binding.path;
            const initNode = node.init;

            if (initNode && binding.constant && scope.isPure(initNode, true)) {
              hoistedVariables.add(node);
              isAllowedIdentifier = true;
            }
          }
        }

        if (!isAllowedIdentifier) {
          throw id.buildCodeFrameError(
            'The module factory of `jest.mock()` is not allowed to ' +
              'reference any out-of-scope variables.\n' +
              'Invalid variable access: ' +
              name +
              '\n' +
              'Allowed objects: ' +
              Array.from(ALLOWED_IDENTIFIERS).join(', ') +
              '.\n' +
              'Note: This is a precaution to guard against uninitialized mock ' +
              'variables. If it is ensured that the mock is required lazily, ' +
              'variable names prefixed with `mock` (case insensitive) are permitted.\n',
            ReferenceError,
          );
        }
      }
    }

    return true;
  }
  return false;
};

FUNCTIONS.unmock = args => args.length === 1 && args[0].isStringLiteral();
FUNCTIONS.deepUnmock = args => args.length === 1 && args[0].isStringLiteral();
FUNCTIONS.disableAutomock = FUNCTIONS.enableAutomock = args =>
  args.length === 0;

const createJestObjectGetter = statement`
function GETTER_NAME() {
  const { JEST_GLOBALS_MODULE_JEST_EXPORT_NAME } = require("JEST_GLOBALS_MODULE_NAME");
  GETTER_NAME = () => JEST_GLOBALS_MODULE_JEST_EXPORT_NAME;
  return JEST_GLOBALS_MODULE_JEST_EXPORT_NAME;
}
`;

const isJestObject = (expression: NodePath<Expression>): boolean => {
  // global
  if (
    expression.isIdentifier() &&
    expression.node.name === JEST_GLOBAL_NAME &&
    !expression.scope.hasBinding(JEST_GLOBAL_NAME)
  ) {
    return true;
  }
  // import { jest } from '@jest/globals'
  if (
    expression.referencesImport(
      JEST_GLOBALS_MODULE_NAME,
      JEST_GLOBALS_MODULE_JEST_EXPORT_NAME,
    )
  ) {
    return true;
  }
  // import * as JestGlobals from '@jest/globals'
  if (
    expression.isMemberExpression() &&
    !expression.node.computed &&
    expression
      .get<'object'>('object')
      .referencesImport(JEST_GLOBALS_MODULE_NAME, '*') &&
    expression.node.property.type === 'Identifier' &&
    expression.node.property.name === JEST_GLOBALS_MODULE_JEST_EXPORT_NAME
  ) {
    return true;
  }

  return false;
};

const extractJestObjExprIfHoistable = <T extends Node>(
  expr: NodePath<T>,
): NodePath<Expression> | null => {
  if (!expr.isCallExpression()) {
    return null;
  }

  const callee = expr.get<'callee'>('callee');
  const args = expr.get<'arguments'>('arguments');

  if (!callee.isMemberExpression() || callee.node.computed) {
    return null;
  }

  const object = callee.get<'object'>('object');
  const property = callee.get<'property'>('property') as NodePath<Identifier>;
  const propertyName = property.node.name;

  const jestObjExpr = isJestObject(object)
    ? object
    : // The Jest object could be returned from another call since the functions are all chainable.
      extractJestObjExprIfHoistable(object);
  if (!jestObjExpr) {
    return null;
  }

  // Important: Call the function check last
  // It might throw an error to display to the user,
  // which should only happen if we're already sure it's a call on the Jest object.
  const functionLooksHoistable = FUNCTIONS[propertyName]?.(args);

  return functionLooksHoistable ? jestObjExpr : null;
};

/* eslint-disable sort-keys */
export default (): PluginObj<{
  declareJestObjGetterIdentifier: () => Identifier;
  jestObjGetterIdentifier?: Identifier;
}> => ({
  pre({path: program}) {
    this.declareJestObjGetterIdentifier = () => {
      if (this.jestObjGetterIdentifier) {
        return this.jestObjGetterIdentifier;
      }

      this.jestObjGetterIdentifier = program.scope.generateUidIdentifier(
        'getJestObj',
      );

      program.unshiftContainer('body', [
        createJestObjectGetter({
          GETTER_NAME: this.jestObjGetterIdentifier.name,
          JEST_GLOBALS_MODULE_JEST_EXPORT_NAME,
          JEST_GLOBALS_MODULE_NAME,
        }),
      ]);

      return this.jestObjGetterIdentifier;
    };
  },
  visitor: {
    ExpressionStatement(exprStmt) {
      const jestObjExpr = extractJestObjExprIfHoistable(
        exprStmt.get('expression'),
      );
      if (jestObjExpr) {
        jestObjExpr.replaceWith(
          callExpression(this.declareJestObjGetterIdentifier(), []),
        );
      }
    },
  },
  // in `post` to make sure we come after an import transform and can unshift above the `require`s
  post({path: program}) {
    const self = this;

    visitBlock(program);
    program.traverse({BlockStatement: visitBlock});

    function visitBlock(block: NodePath<BlockStatement> | NodePath<Program>) {
      // use a temporary empty statement instead of the real first statement, which may itself be hoisted
      const [varsHoistPoint, callsHoistPoint] = block.unshiftContainer('body', [
        emptyStatement(),
        emptyStatement(),
      ]);
      block.traverse({
        CallExpression: visitCallExpr,
        VariableDeclarator: visitVariableDeclarator,
        // do not traverse into nested blocks, or we'll hoist calls in there out to this block
        blacklist: ['BlockStatement'],
      });
      callsHoistPoint.remove();
      varsHoistPoint.remove();

      function visitCallExpr(callExpr: NodePath<CallExpression>) {
        const {
          node: {callee},
        } = callExpr;
        if (
          isIdentifier(callee) &&
          callee.name === self.jestObjGetterIdentifier?.name
        ) {
          const mockStmt = callExpr.getStatementParent();

          if (mockStmt) {
            const mockStmtParent = mockStmt.parentPath;
            if (mockStmtParent.isBlock()) {
              const mockStmtNode = mockStmt.node;
              mockStmt.remove();
              callsHoistPoint.insertBefore(mockStmtNode);
            }
          }
        }
      }

      function visitVariableDeclarator(varDecl: NodePath<VariableDeclarator>) {
        if (hoistedVariables.has(varDecl.node)) {
          // should be assert function, but it's not. So let's cast below
          varDecl.parentPath.assertVariableDeclaration();

          const {kind, declarations} = varDecl.parent as VariableDeclaration;
          if (declarations.length === 1) {
            varDecl.parentPath.remove();
          } else {
            varDecl.remove();
          }
          varsHoistPoint.insertBefore(
            variableDeclaration(kind, [varDecl.node]),
          );
        }
      }
    }
  },
});
/* eslint-enable */
