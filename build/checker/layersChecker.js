"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const typescript_1 = __importDefault(require("typescript"));
const fs_1 = require("fs");
const path_1 = require("path");
const minimatch_1 = require("minimatch");
//
// #############################################################################################
//
// A custom typescript checker for the specific task of detecting the use of certain types in a
// layer that does not allow such use. For example:
// - using DOM globals in common/node/electron-main layer (e.g. HTMLElement)
// - using node.js globals in common/browser layer (e.g. process)
//
// Make changes to below RULES to lift certain files from these checks only if absolutely needed
//
// #############################################################################################
//
// Types we assume are present in all implementations of JS VMs (node.js, browsers)
// Feel free to add more core types as you see needed if present in node.js and browsers
const CORE_TYPES = [
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    'console',
    'Console',
    'Error',
    'ErrorConstructor',
    'String',
    'TextDecoder',
    'TextEncoder',
    'self',
    'queueMicrotask',
    'Array',
    'Uint8Array',
    'Uint16Array',
    'Uint32Array',
    'Int8Array',
    'Int16Array',
    'Int32Array',
    'Float32Array',
    'Float64Array',
    'Uint8ClampedArray',
    'BigUint64Array',
    'BigInt64Array',
    'btoa',
    'atob',
    'AbortController',
    'AbortSignal',
    'MessageChannel',
    'MessagePort',
    'URL',
    'URLSearchParams',
    'ReadonlyArray',
    'Event',
    'EventTarget',
    'BroadcastChannel',
    'performance',
    'Blob',
    'crypto',
    'File',
    'fetch',
    'RequestInit',
    'Headers',
    'Request',
    'Response',
    'Body',
    'any',
    'timeout',
    'Performance',
    'PerformanceMark',
    'PerformanceObserver',
    'ImportMeta',
    'structuredClone',
    'stackTraceLimit',
    'captureStackTrace',
    // webcrypto has been available since Node.js 19, but still live in dom.d.ts
    'Crypto',
    'SubtleCrypto',
    'JsonWebKey',
    'MessageEvent',
    // node web types
    'ReadableStream',
    'ReadableStreamReadResult',
    'ReadableStreamGenericReader',
    'ReadableStreamDefaultReader',
    'value',
    'done',
    'DOMException',
    'WebSocket',
];
// Types that are defined in a common layer but are known to be only
// available in native environments should not be allowed in browser
const NATIVE_TYPES = [
    'NativeParsedArgs',
    'INativeEnvironmentService',
    'AbstractNativeEnvironmentService',
    'INativeWindowConfiguration',
    'ICommonNativeHostService',
    'INativeHostService',
    'IMainProcessService',
    'INativeBrowserElementsService',
];
const RULES = [
    // Tests: skip
    {
        target: '**/vs/**/test/**',
        skip: true // -> skip all test files
    },
    // Common: vs/base/common/async.ts
    {
        target: '**/vs/base/common/async.ts',
        allowedTypes: [
            ...CORE_TYPES,
            // Safe access to requestIdleCallback & cancelIdleCallback
            'requestIdleCallback',
            'cancelIdleCallback'
        ],
        disallowedTypes: NATIVE_TYPES,
        disallowedDefinitions: [
            'lib.dom.d.ts', // no DOM
            '@types/node' // no node.js
        ]
    },
    // Common: vs/base/common/performance.ts
    {
        target: '**/vs/base/common/performance.ts',
        allowedTypes: [
            ...CORE_TYPES,
            // Safe access to Performance
            'Performance',
            'PerformanceEntry',
            'PerformanceTiming'
        ],
        disallowedTypes: NATIVE_TYPES,
        disallowedDefinitions: [
            'lib.dom.d.ts', // no DOM
            '@types/node' // no node.js
        ]
    },
    // Common: vs/platform services that can access native types
    {
        target: `**/vs/platform/{${[
            'environment/common/*.ts',
            'window/common/window.ts',
            'native/common/native.ts',
            'native/common/nativeHostService.ts',
            'browserElements/common/browserElements.ts',
            'browserElements/common/nativeBrowserElementsService.ts'
        ].join(',')}}`,
        allowedTypes: CORE_TYPES,
        disallowedTypes: [ /* Ignore native types that are defined from here */],
        disallowedDefinitions: [
            'lib.dom.d.ts', // no DOM
            '@types/node' // no node.js
        ]
    },
    // Common: vs/base/parts/sandbox/electron-sandbox/preload{,-aux}.ts
    {
        target: '**/vs/base/parts/sandbox/electron-sandbox/preload{,-aux}.ts',
        allowedTypes: [
            ...CORE_TYPES,
            // Safe access to a very small subset of node.js
            'process',
            'NodeJS',
            '__global'
        ],
        disallowedTypes: NATIVE_TYPES,
        disallowedDefinitions: [
            '@types/node' // no node.js
        ]
    },
    // Common
    {
        target: '**/vs/**/common/**',
        allowedTypes: CORE_TYPES,
        disallowedTypes: NATIVE_TYPES,
        disallowedDefinitions: [
            'lib.dom.d.ts', // no DOM
            '@types/node' // no node.js
        ]
    },
    // Browser
    {
        target: '**/vs/**/browser/**',
        allowedTypes: [
            ...CORE_TYPES,
            'localStorage'
        ],
        disallowedTypes: NATIVE_TYPES,
        disallowedDefinitions: [
            '@types/node' // no node.js
        ]
    },
    // node.js
    {
        target: '**/vs/**/node/**',
        allowedTypes: CORE_TYPES,
        disallowedDefinitions: [
            'lib.dom.d.ts' // no DOM
        ]
    },
    // Electron (sandbox)
    {
        target: '**/vs/**/electron-sandbox/**',
        allowedTypes: CORE_TYPES,
        disallowedDefinitions: [
            '@types/node' // no node.js
        ]
    },
    // Electron (main, utility)
    {
        target: '**/vs/**/{electron-main,electron-utility}/**',
        allowedTypes: CORE_TYPES,
        disallowedTypes: [
            'ipcMain' // not allowed, use validatedIpcMain instead
        ],
        disallowedDefinitions: [
            'lib.dom.d.ts' // no DOM
        ]
    }
];
const TS_CONFIG_PATH = (0, path_1.join)(__dirname, '../../', 'src', 'tsconfig.json');
let hasErrors = false;
function checkFile(program, sourceFile, rule) {
    checkNode(sourceFile);
    function checkNode(node) {
        if (node.kind !== typescript_1.default.SyntaxKind.Identifier) {
            return typescript_1.default.forEachChild(node, checkNode); // recurse down
        }
        const checker = program.getTypeChecker();
        const symbol = checker.getSymbolAtLocation(node);
        if (!symbol) {
            return;
        }
        let text = symbol.getName();
        if (rule.allowedTypes?.some(allowed => allowed === text)) {
            return; // override
        }
        let _parentSymbol = symbol;
        while (_parentSymbol.parent) {
            _parentSymbol = _parentSymbol.parent;
        }
        const parentSymbol = _parentSymbol;
        text = parentSymbol.getName();
        if (rule.allowedTypes?.some(allowed => allowed === text)) {
            return; // override
        }
        if (rule.disallowedTypes?.some(disallowed => disallowed === text)) {
            const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
            console.log(`[build/checker/layersChecker.ts]: Reference to type '${text}' violates layer '${rule.target}' (${sourceFile.fileName} (${line + 1},${character + 1}). Learn more about our source code organization at https://github.com/microsoft/vscode/wiki/Source-Code-Organization.`);
            hasErrors = true;
            return;
        }
        const declarations = symbol.declarations;
        if (Array.isArray(declarations)) {
            DeclarationLoop: for (const declaration of declarations) {
                if (declaration) {
                    const parent = declaration.parent;
                    if (parent) {
                        const parentSourceFile = parent.getSourceFile();
                        if (parentSourceFile) {
                            const definitionFileName = parentSourceFile.fileName;
                            if (rule.allowedDefinitions) {
                                for (const allowedDefinition of rule.allowedDefinitions) {
                                    if (definitionFileName.indexOf(allowedDefinition) >= 0) {
                                        continue DeclarationLoop;
                                    }
                                }
                            }
                            if (rule.disallowedDefinitions) {
                                for (const disallowedDefinition of rule.disallowedDefinitions) {
                                    if (definitionFileName.indexOf(disallowedDefinition) >= 0) {
                                        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
                                        console.log(`[build/checker/layersChecker.ts]: Reference to symbol '${text}' from '${disallowedDefinition}' violates layer '${rule.target}' (${sourceFile.fileName} (${line + 1},${character + 1}) Learn more about our source code organization at https://github.com/microsoft/vscode/wiki/Source-Code-Organization.`);
                                        hasErrors = true;
                                        return;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
function createProgram(tsconfigPath) {
    const tsConfig = typescript_1.default.readConfigFile(tsconfigPath, typescript_1.default.sys.readFile);
    const configHostParser = { fileExists: fs_1.existsSync, readDirectory: typescript_1.default.sys.readDirectory, readFile: file => (0, fs_1.readFileSync)(file, 'utf8'), useCaseSensitiveFileNames: process.platform === 'linux' };
    const tsConfigParsed = typescript_1.default.parseJsonConfigFileContent(tsConfig.config, configHostParser, (0, path_1.resolve)((0, path_1.dirname)(tsconfigPath)), { noEmit: true });
    const compilerHost = typescript_1.default.createCompilerHost(tsConfigParsed.options, true);
    return typescript_1.default.createProgram(tsConfigParsed.fileNames, tsConfigParsed.options, compilerHost);
}
//
// Create program and start checking
//
const program = createProgram(TS_CONFIG_PATH);
for (const sourceFile of program.getSourceFiles()) {
    for (const rule of RULES) {
        if ((0, minimatch_1.match)([sourceFile.fileName], rule.target).length > 0) {
            if (!rule.skip) {
                checkFile(program, sourceFile, rule);
            }
            break;
        }
    }
}
if (hasErrors) {
    process.exit(1);
}
//# sourceMappingURL=layersChecker.js.map