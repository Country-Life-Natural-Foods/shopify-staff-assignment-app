'use strict';

const crypto = require('crypto');
const { shopifyGraphql, userErrorsMessage } = require('./shopify-gql');

const APP_USER_TYPE = '$app:app_user';
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 };
const PIN_PATTERN = /^\d{4,8}$/;

const LIST_USERS_QUERY = `
  query AppUsers($type: String!, $first: Int!) {
    metaobjects(type: $type, first: $first) {
      nodes {
        id
        handle
        name: field(key: "name") { jsonValue }
        pinHash: field(key: "pin_hash") { jsonValue }
        isAdmin: field(key: "is_admin") { jsonValue }
      }
    }
  }
`;

const UPSERT_USER_MUTATION = `
  mutation UpsertAppUser($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
    metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
      metaobject { id handle }
      userErrors { field message }
    }
  }
`;

const DELETE_USER_MUTATION = `
  mutation DeleteMetaobject($id: ID!) {
    metaobjectDelete(id: $id) {
      deletedId
      userErrors { field message }
    }
  }
`;

function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pin), salt, 32, SCRYPT_OPTIONS);
  return `s$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

function verifyPin(pin, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 's') return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[1], 'base64url');
    expected = Buffer.from(parts[2], 'base64url');
  } catch {
    return false;
  }
  const hash = crypto.scryptSync(String(pin), salt, 32, SCRYPT_OPTIONS);
  if (hash.length !== expected.length) return false;
  return crypto.timingSafeEqual(hash, expected);
}

function assertPin(pin) {
  if (!PIN_PATTERN.test(String(pin || ''))) {
    const err = new Error('PIN must be 4 to 8 digits');
    err.status = 400;
    throw err;
  }
}

function asBoolean(value) {
  return value === true || value === 'true';
}

function toPublicUser(node) {
  return {
    id: node.id,
    handle: node.handle,
    name: String(node.name?.jsonValue || node.handle || 'Account'),
    isAdmin: asBoolean(node.isAdmin?.jsonValue),
  };
}

function toHandle(name) {
  const base = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'user';
  return `${base}-${crypto.randomBytes(3).toString('hex')}`;
}

async function listAppUsers(client) {
  const data = await shopifyGraphql(
    client,
    LIST_USERS_QUERY,
    { type: APP_USER_TYPE, first: 50 },
    'app users',
  );
  return (data?.metaobjects?.nodes || []).map((node) => ({
    ...toPublicUser(node),
    pinHash: String(node.pinHash?.jsonValue || ''),
  }));
}

async function upsertAppUser(client, { handle, name, pin, pinHash, isAdmin }) {
  const fields = [
    { key: 'name', value: String(name) },
    { key: 'is_admin', value: isAdmin ? 'true' : 'false' },
  ];
  if (pin != null) {
    assertPin(pin);
    fields.push({ key: 'pin_hash', value: hashPin(pin) });
  } else if (pinHash) {
    fields.push({ key: 'pin_hash', value: pinHash });
  } else {
    const err = new Error('PIN is required');
    err.status = 400;
    throw err;
  }
  const data = await shopifyGraphql(
    client,
    UPSERT_USER_MUTATION,
    {
      handle: { type: APP_USER_TYPE, handle },
      metaobject: { fields },
    },
    'upsert app user',
  );
  const result = data?.metaobjectUpsert;
  const errMsg = userErrorsMessage(result?.userErrors);
  if (errMsg) {
    const err = new Error(errMsg);
    err.status = 400;
    throw err;
  }
  return result.metaobject;
}

async function deleteAppUser(client, id) {
  const data = await shopifyGraphql(
    client,
    DELETE_USER_MUTATION,
    { id },
    'delete app user',
  );
  const result = data?.metaobjectDelete;
  const errMsg = userErrorsMessage(result?.userErrors);
  if (errMsg) {
    const err = new Error(errMsg);
    err.status = 400;
    throw err;
  }
  return result.deletedId;
}

module.exports = {
  APP_USER_TYPE,
  assertPin,
  verifyPin,
  toHandle,
  listAppUsers,
  upsertAppUser,
  deleteAppUser,
};
