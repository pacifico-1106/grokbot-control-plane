/**
 * staffpass/json-utf8 (木村 2026-10-12): NextResponse.json sends a bare
 * `application/json` on Node (no charset) and browsers can show Japanese text
 * garbled. Use jsonUtf8 from @/lib/http/json-utf8 instead.
 *
 * Allowed only when the init is an object literal whose `headers` object
 * literal sets content-type with an explicit charset. Anything else (no init,
 * headers from a variable, init from a variable) is reported.
 */
function keyName(prop) {
  if (!prop || prop.type !== "Property") return "";
  if (prop.key.type === "Identifier" && !prop.computed) return prop.key.name;
  if (prop.key.type === "Literal") return String(prop.key.value);
  return "";
}

function stringValue(node) {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral") return node.quasis.map((q) => q.value.cooked ?? "").join("");
  return null;
}

function hasCharsetContentType(init) {
  if (!init || init.type !== "ObjectExpression") return false;
  const headers = init.properties.find((p) => keyName(p) === "headers");
  if (!headers || headers.value.type !== "ObjectExpression") return false;
  const ct = headers.value.properties.find((p) => keyName(p).toLowerCase() === "content-type");
  const value = ct ? stringValue(ct.value) : null;
  return typeof value === "string" && /charset\s*=/i.test(value);
}

function isNextResponseJson(callee) {
  if (!callee || callee.type !== "MemberExpression") return false;
  if (callee.object.type !== "Identifier" || callee.object.name !== "NextResponse") return false;
  if (!callee.computed) return callee.property.type === "Identifier" && callee.property.name === "json";
  return callee.property.type === "Literal" && callee.property.value === "json";
}

const rule = {
  meta: {
    type: "problem",
    docs: { description: "Require a charset on JSON responses: use jsonUtf8 instead of NextResponse.json" },
    schema: [],
    messages: {
      useJsonUtf8:
        "Use jsonUtf8() from @/lib/http/json-utf8 instead of NextResponse.json: on Node it sends application/json without a charset and Japanese text is garbled in browsers.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isNextResponseJson(node.callee)) return;
        if (hasCharsetContentType(node.arguments[1])) return;
        context.report({ node, messageId: "useJsonUtf8" });
      },
    };
  },
};

export default rule;
