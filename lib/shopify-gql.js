'use strict';

function uniqueErrorMessages(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return '';
  const seen = new Set();
  const messages = [];
  for (const err of errors) {
    const message = String(err?.message || '').trim();
    if (!message || seen.has(message)) continue;
    seen.add(message);
    messages.push(message);
  }
  return messages.join('; ');
}

async function shopifyGraphql(client, query, variables, label) {
  const response = await client.request(query, { variables });
  const gql = response?.errors?.graphQLErrors;
  const gqlMessage = uniqueErrorMessages(gql);
  if (gqlMessage) {
    throw new Error(`${label}: ${gqlMessage}`);
  }
  const errs = response?.errors;
  const errMessage = uniqueErrorMessages(Array.isArray(errs) ? errs : []);
  if (errMessage) {
    throw new Error(`${label}: ${errMessage}`);
  }
  if (errs?.message) {
    throw new Error(`${label}: ${errs.message}`);
  }
  return response?.data;
}

function userErrorsMessage(userErrors) {
  if (!Array.isArray(userErrors) || userErrors.length === 0) return '';
  return userErrors.map((e) => e.message).join('; ');
}

function isAccessDenied(err) {
  const message = String(err?.message || err || '').toLowerCase();
  return (
    message.includes('access denied') ||
    message.includes('not authorized') ||
    message.includes('permission') ||
    message.includes("doesn't have a valid") ||
    message.includes('access scope')
  );
}

function isMissingDefinition(err) {
  const message = String(err?.message || err || '').toLowerCase();
  return (
    message.includes('unknown type') ||
    message.includes('no metaobject definition') ||
    message.includes('does not exist') ||
    message.includes("doesn't exist")
  );
}

module.exports = {
  shopifyGraphql,
  uniqueErrorMessages,
  userErrorsMessage,
  isAccessDenied,
  isMissingDefinition,
};
