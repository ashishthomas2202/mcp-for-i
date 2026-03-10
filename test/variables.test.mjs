import test from "node:test";
import assert from "node:assert/strict";
import { Variables } from "../dist/ibmi/variables.js";

test("Variables.expand escapes regex metacharacters like *", () => {
  const vars = new Variables(undefined, new Map([["*CURLIB", "QGPL"]]));
  const out = vars.expand("LIB(*CURLIB)");
  assert.equal(out, "LIB(QGPL)");
});
