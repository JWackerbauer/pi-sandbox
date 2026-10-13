// Tests for the mustache-like skill template engine.

import test from "node:test";
import assert from "node:assert/strict";
import { renderTemplate } from "./skill-template";

test("interpolates a simple variable (with and without inner spaces)", () => {
  assert.equal(renderTemplate("hello {{name}}!", { name: "world" }), "hello world!");
  assert.equal(renderTemplate("hello {{ name }}!", { name: "world" }), "hello world!");
});

test("a missing variable renders as an empty string", () => {
  assert.equal(renderTemplate("a {{ missing }} b", {}), "a  b");
  assert.equal(renderTemplate("{{ absent }}", {}), "");
});

test("an array value is joined with ', '", () => {
  assert.equal(renderTemplate("{{ items }}", { items: ["a", "b", "c"] }), "a, b, c");
  assert.equal(renderTemplate("{{ items }}", { items: [] }), "");
});

test("a boolean value renders as 'true'/'false'", () => {
  assert.equal(renderTemplate("{{ flag }}", { flag: true }), "true");
  assert.equal(renderTemplate("{{ flag }}", { flag: false }), "false");
});

test("a number value renders via String()", () => {
  assert.equal(renderTemplate("{{ n }}", { n: 42 }), "42");
});

test("a truthy section is included", () => {
  const t = "before{{#on}}yes{{/on}}after";
  assert.equal(renderTemplate(t, { on: true }), "beforeyesafter");
  // Non-empty string is truthy too.
  assert.equal(renderTemplate(t, { on: "set" }), "beforeyesafter");
});

test("a falsy/absent section is omitted", () => {
  const t = "before{{#off}}nope{{/off}}after";
  assert.equal(renderTemplate(t, { off: false }), "beforeafter");
  assert.equal(renderTemplate(t, {}), "beforeafter");
  // Empty string and 0 are falsy.
  assert.equal(renderTemplate(t, { off: "" }), "beforeafter");
  assert.equal(renderTemplate(t, { off: 0 }), "beforeafter");
});

test("an inverted section is included only when falsy", () => {
  const t = "x{{^off}}absent{{/off}}y";
  assert.equal(renderTemplate(t, {}), "xabsenty");
  assert.equal(renderTemplate(t, { off: false }), "xabsenty");
  // Truthy → the inverted section is skipped.
  assert.equal(renderTemplate(t, { off: true }), "xy");
});

test("sections nest, same or different names", () => {
  const t = "{{#a}}[{{#b}}inner{{/b}}]{{/a}}";
  assert.equal(renderTemplate(t, { a: true, b: true }), "[inner]");
  assert.equal(renderTemplate(t, { a: true, b: false }), "[]");
  assert.equal(renderTemplate(t, { a: false, b: true }), "");
});

test("a comment tag is removed", () => {
  assert.equal(renderTemplate("a{{! a comment }}b", {}), "ab");
  assert.equal(renderTemplate("{{! hidden }}shown", {}), "shown");
});

test("a stray {{ without a closing }} is preserved as literal text", () => {
  assert.equal(renderTemplate("price is {{name", { name: "x" }), "price is {{name");
  // Only the stray part is literal; a real tag before it still renders.
  assert.equal(renderTemplate("{{name}} and {{stray", { name: "x" }), "x and {{stray");
});

test("an unmatched section close is ignored", () => {
  assert.equal(renderTemplate("text{{/name}}more", {}), "textmore");
});
