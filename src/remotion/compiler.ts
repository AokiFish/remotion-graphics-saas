import * as Babel from "@babel/standalone";
import { Lottie } from "@remotion/lottie";
import * as RemotionShapes from "@remotion/shapes";
import { ThreeCanvas } from "@remotion/three";
import {
  TransitionSeries,
  linearTiming,
  springTiming,
} from "@remotion/transitions";
import { clockWipe } from "@remotion/transitions/clock-wipe";
import { fade } from "@remotion/transitions/fade";
import { flip } from "@remotion/transitions/flip";
import { slide } from "@remotion/transitions/slide";
import { wipe } from "@remotion/transitions/wipe";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AbsoluteFill,
  Img,
  Sequence,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import * as THREE from "three";

export interface CompilationResult {
  Component: React.ComponentType | null;
  error: string | null;
}

// Remove all import statements from LLM-generated code.
function stripImports(code: string): string {
  let cleaned = code;

  cleaned = cleaned.replace(
    /import\s+type\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?/g,
    "",
  );
  cleaned = cleaned.replace(
    /import\s+\w+\s*,\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?/g,
    "",
  );
  cleaned = cleaned.replace(
    /import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?/g,
    "",
  );
  cleaned = cleaned.replace(
    /import\s+\*\s+as\s+\w+\s+from\s*["'][^"']+["'];?/g,
    "",
  );
  cleaned = cleaned.replace(/import\s+\w+\s+from\s*["'][^"']+["'];?/g, "");
  cleaned = cleaned.replace(/import\s*["'][^"']+["'];?/g, "");

  return cleaned;
}

// ---------------------------------------------------------------------------
// AST-based component location
//
// LLMs emit wildly different shapes: `export const X = () => {}`,
// `export default function X() {}`, plain `function X() {}`, a typed
// `const X: FC = () => {}`, an outer wrapper with the real component nested
// inside, several helper components, etc. Scanning the source with string
// indexes breaks on most of those, so we parse the code with Babel's own
// parser and pick the component from the AST instead.
// ---------------------------------------------------------------------------

interface AstNode {
  type: string;
  start?: number;
  end?: number;
  id?: AstNode | null;
  body?: AstNode | AstNode[];
  argument?: AstNode | null;
  declarations?: AstNode[];
  init?: AstNode | null;
  callee?: AstNode;
  property?: AstNode | null;
  // Babel nodes carry many extra fields we only walk generically.
  [key: string]: unknown;
}

interface AstFile {
  program: { body?: AstNode[] };
}

interface BabelParser {
  parse(code: string, options: Record<string, unknown>): AstFile;
}

type TraverseFn = (
  ast: AstFile,
  visitors: Record<string, (path: { node: AstNode; parent: AstNode }) => void>,
) => void;

const GENERATED_NAME = "__GeneratedAnimation";
const DEFAULT_EXPORT_NAME = "__DefaultExport";

const babelPkgs = (
  Babel as unknown as {
    packages: {
      parser: BabelParser;
      traverse: TraverseFn | { default: TraverseFn };
    };
  }
).packages;

const babylonParser = babelPkgs.parser;
const babylonTraverse: TraverseFn =
  typeof babelPkgs.traverse === "function"
    ? babelPkgs.traverse
    : babelPkgs.traverse.default;

// Remove a leading/trailing markdown code fence if the model ignored
// the "output code only" instruction.
function stripCodeFence(code: string): string {
  const trimmed = code.trim();
  const fence = trimmed.match(/^```(?:tsx|jsx|ts|js)?\s*\n([\s\S]*?)\n?```$/);
  return fence ? fence[1].trim() : trimmed;
}

// Convert `export` declarations into plain top-level declarations, since the
// extracted code is evaluated as a function body (no module scope).
function stripExports(code: string): string {
  let cleaned = code.replace(
    /^([ \t]*)export\s+default\s+(?=function|class|const|let|var)/gm,
    "$1",
  );
  cleaned = cleaned.replace(
    /^([ \t]*)export\s+default\s+/gm,
    `$1const ${DEFAULT_EXPORT_NAME} = `,
  );
  cleaned = cleaned.replace(/^([ \t]*)export\s+/gm, "$1");
  return cleaned;
}

function children(node: AstNode): AstNode[] {
  const out: AstNode[] = [];
  for (const key of Object.keys(node)) {
    if (
      key === "loc" ||
      key === "leadingComments" ||
      key === "trailingComments" ||
      key === "innerComments"
    ) {
      continue;
    }
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object" && "type" in item) {
          out.push(item as AstNode);
        }
      }
    } else if (value && typeof value === "object" && "type" in value) {
      out.push(value as AstNode);
    }
  }
  return out;
}

function walk(node: AstNode, visit: (node: AstNode) => boolean): boolean {
  if (visit(node)) return true;
  for (const child of children(node)) {
    if (walk(child, visit)) return true;
  }
  return false;
}

function containsJSX(node: AstNode): boolean {
  // JSX itself, or `React.createElement(...)` from a transpiled source.
  return walk(node, (n) => {
    if (n.type === "JSXElement" || n.type === "JSXFragment") return true;
    if (n.type === "CallExpression") {
      const callee = n.callee;
      if (callee?.type === "MemberExpression") {
        const property = (callee as unknown as AstNode).property;
        if (property?.name === "createElement") return true;
      }
    }
    return false;
  });
}

// True when the component body has a `return` of JSX.
function returnsJSX(node: AstNode): boolean {
  const body = node.body;
  if (!body) return false;
  const roots = Array.isArray(body) ? body : [body];
  return roots.some((root) =>
    walk(root, (n) => {
      if (n.type === "ReturnStatement") {
        const arg = n.argument;
        if (arg && containsJSX(arg)) return true;
      }
      return false;
    }),
  );
}

interface ComponentCandidate {
  node: AstNode;
  name: string | null;
  topLevel: boolean;
  expression: boolean;
}

function nameFromParent(parent: AstNode): string | null {
  if (parent?.type === "VariableDeclarator" && parent.id?.name) {
    return String(parent.id.name);
  }
  return null;
}

function tryParse(source: string, extraClosings: number) {
  const attempt = extraClosings
    ? `${source}\n${"}".repeat(extraClosings)}`
    : source;
  try {
    return {
      ast: babylonParser.parse(attempt, {
        sourceType: "module",
        plugins: ["jsx", "typescript"],
        errorRecovery: true,
        allowReturnOutsideFunction: true,
      }),
      source: attempt,
    };
  } catch {
    return null;
  }
}

// Parse, retrying with extra closing braces (models sometimes emit truncated
// code) so mildly broken output still yields an AST.
function parseWithRecovery(source: string) {
  for (let extra = 0; extra <= 3; extra++) {
    const result = tryParse(source, extra);
    if (result) return result;
  }
  return null;
}

interface LocatedComponent {
  /** Source with the component available at (or hoisted to) the top level. */
  source: string;
  /** Name to return from the generated factory function. */
  exportName: string;
}

/**
 * Find the one component the model actually wants rendered.
 *
 * Priority: exported names first (models export the main scene), then the
 * top-level declaration, then the innermost function that returns JSX.
 * Returns `null` only when nothing at all can be salvaged.
 */
function locateComponent(code: string): LocatedComponent | null {
  let cleaned = stripImports(stripCodeFence(code)).trim();
  if (!cleaned) return null;

  const exportedNames = new Set<string>();
  const exportRe = /export\s+(?:const|function|class|let|var)\s+([A-Za-z_$][\w$]*)/g;
  let match: RegExpExecArray | null;
  while ((match = exportRe.exec(cleaned)) !== null) {
    exportedNames.add(match[1]);
  }

  cleaned = stripExports(cleaned).trim();

  const parsed = parseWithRecovery(cleaned);
  if (!parsed) return null;
  cleaned = parsed.source;
  const { ast } = parsed;

  const topLevel = new Set<AstNode>();
  for (const statement of ast.program.body ?? []) {
    if (
      (statement.type === "ExportNamedDeclaration" ||
        statement.type === "ExportDefaultDeclaration") &&
      statement.declaration
    ) {
      topLevel.add(statement.declaration as AstNode);
    } else if (statement.type === "VariableDeclaration") {
      for (const declarator of statement.declarations ?? []) {
        if (declarator.init) topLevel.add(declarator.init);
      }
    } else {
      topLevel.add(statement);
    }
  }

  const candidates: ComponentCandidate[] = [];
  babylonTraverse(ast, {
    FunctionDeclaration(path) {
      candidates.push({
        node: path.node,
        name: path.node.id?.name ? String(path.node.id.name) : null,
        topLevel: topLevel.has(path.node),
        expression: false,
      });
    },
    ClassDeclaration(path) {
      candidates.push({
        node: path.node,
        name: path.node.id?.name ? String(path.node.id.name) : null,
        topLevel: topLevel.has(path.node),
        expression: false,
      });
    },
    ArrowFunctionExpression(path) {
      candidates.push({
        node: path.node,
        name: nameFromParent(path.parent),
        topLevel: topLevel.has(path.node),
        expression: true,
      });
    },
    FunctionExpression(path) {
      candidates.push({
        node: path.node,
        name: nameFromParent(path.parent),
        topLevel: topLevel.has(path.node),
        expression: true,
      });
    },
  });

  if (candidates.length === 0) return null;

  const pick = (list: ComponentCandidate[]) =>
    list.length > 0 ? list[list.length - 1] : null;

  const withJSX = candidates.filter((candidate) => returnsJSX(candidate.node));

  const chosen =
    pick(withJSX.filter((c) => c.name && exportedNames.has(c.name))) ||
    pick(withJSX.filter((c) => c.name && c.topLevel)) ||
    pick(withJSX) ||
    pick(candidates.filter((c) => c.name && exportedNames.has(c.name))) ||
    pick(candidates.filter((c) => c.name && c.topLevel));

  if (!chosen) return null;

  // Named + top level (or a hoisted function declaration): return it directly.
  if (chosen.name && (chosen.topLevel || !chosen.expression)) {
    return { source: cleaned, exportName: chosen.name };
  }

  // Nested/anonymous component: hoist it to the top level under a fresh name.
  const expressionSource = cleaned.slice(chosen.node.start, chosen.node.end);
  return {
    source: `${cleaned}\nconst ${GENERATED_NAME} = ${expressionSource};`,
    exportName: GENERATED_NAME,
  };
}

// Standalone compile function for use outside React components
export function compileCode(code: string): CompilationResult {
  if (!code?.trim()) {
    return { Component: null, error: "No code provided" };
  }

  try {
    const located = locateComponent(code);
    if (!located) {
      // Log a short excerpt so a malformed model response can be diagnosed
      // from the console instead of guessing what the model emitted.
      console.warn(
        "[compiler] No React component found in generated code. First 400 chars:\n" +
          code.slice(0, 400),
      );
      return {
        Component: null,
        error: "Could not locate a React component in the generated code",
      };
    }
    const { source, exportName } = located;

    // Transpile the source as-is: the component already lives at the top level
    // of this snippet (or was hoisted there), so no extra wrapper is needed.
    // The `return` is appended after transpilation, inside the generated
    // function body, so Babel never sees a top-level return.
    const transpiled = Babel.transform(source, {
      presets: ["react", "typescript"],
      filename: "dynamic-animation.tsx",
    });

    if (!transpiled.code) {
      return { Component: null, error: "Transpilation failed" };
    }

    const Remotion = {
      AbsoluteFill,
      interpolate,
      useCurrentFrame,
      useVideoConfig,
      spring,
      Sequence,
      Img,
    };

    const wrappedCode = `${transpiled.code}\nreturn ${exportName};`;

    const createComponent = new Function(
      "React",
      "Remotion",
      "RemotionShapes",
      "Lottie",
      "ThreeCanvas",
      "THREE",
      "AbsoluteFill",
      "interpolate",
      "useCurrentFrame",
      "useVideoConfig",
      "spring",
      "Sequence",
      "Img",
      "useState",
      "useEffect",
      "useMemo",
      "useRef",
      "Rect",
      "Circle",
      "Triangle",
      "Star",
      "Polygon",
      "Ellipse",
      "Heart",
      "Pie",
      "makeRect",
      "makeCircle",
      "makeTriangle",
      "makeStar",
      "makePolygon",
      "makeEllipse",
      "makeHeart",
      "makePie",
      // Transitions
      "TransitionSeries",
      "linearTiming",
      "springTiming",
      "fade",
      "slide",
      "wipe",
      "flip",
      "clockWipe",
      wrappedCode,
    );

    const Component = createComponent(
      React,
      Remotion,
      RemotionShapes,
      Lottie,
      ThreeCanvas,
      THREE,
      AbsoluteFill,
      interpolate,
      useCurrentFrame,
      useVideoConfig,
      spring,
      Sequence,
      Img,
      useState,
      useEffect,
      useMemo,
      useRef,
      RemotionShapes.Rect,
      RemotionShapes.Circle,
      RemotionShapes.Triangle,
      RemotionShapes.Star,
      RemotionShapes.Polygon,
      RemotionShapes.Ellipse,
      RemotionShapes.Heart,
      RemotionShapes.Pie,
      RemotionShapes.makeRect,
      RemotionShapes.makeCircle,
      RemotionShapes.makeTriangle,
      RemotionShapes.makeStar,
      RemotionShapes.makePolygon,
      RemotionShapes.makeEllipse,
      RemotionShapes.makeHeart,
      RemotionShapes.makePie,
      // Transitions
      TransitionSeries,
      linearTiming,
      springTiming,
      fade,
      slide,
      wipe,
      flip,
      clockWipe,
    );

    if (typeof Component !== "function") {
      return {
        Component: null,
        error: "Code must be a function that returns a React component",
      };
    }

    return { Component, error: null };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown compilation error";
    return { Component: null, error: errorMessage };
  }
}
