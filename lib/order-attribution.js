'use strict';

const CHECKOUT_CHANNEL_COMPANY = 'company';
const CHECKOUT_CHANNEL_CONTACT = 'contact';

function normalizeCompanyId(raw) {
  if (raw == null || raw === '') return null;
  const value = String(raw);
  if (value.startsWith('gid://shopify/Company/')) return value;
  if (/^\d+$/.test(value)) return `gid://shopify/Company/${value}`;
  return value.startsWith('gid://') ? value : null;
}

function normalizeCustomerId(raw) {
  if (raw == null || raw === '') return null;
  const value = String(raw);
  if (value.startsWith('gid://shopify/Customer/')) return value;
  if (/^\d+$/.test(value)) return `gid://shopify/Customer/${value}`;
  return value.startsWith('gid://') ? value : null;
}

/**
 * Prefer PurchasingCompany when present. Otherwise attribute a contact's
 * customer checkout to their B2B company when the link is unambiguous.
 */
function resolveCompanyFromContacts(profiles) {
  const list = (Array.isArray(profiles) ? profiles : [])
    .map((profile) => ({
      companyId: normalizeCompanyId(profile?.company?.id),
      isMainContact: Boolean(profile?.isMainContact),
    }))
    .filter((profile) => profile.companyId);
  if (!list.length) return null;

  const uniqueIds = [...new Set(list.map((profile) => profile.companyId))];
  if (uniqueIds.length === 1) return uniqueIds[0];

  const mainIds = [...new Set(
    list.filter((profile) => profile.isMainContact).map((profile) => profile.companyId),
  )];
  if (mainIds.length === 1) return mainIds[0];
  return null;
}

function orderCompanyId(order) {
  return normalizeCompanyId(order?.purchasingEntity?.company?.id)
    || resolveCompanyFromContacts(order?.customer?.companyContactProfiles)
    || null;
}

/** How the order was checked out: B2B company vs contact customer account. */
function resolveCheckoutChannel({ fromPurchasingCompany, companyId, existingChannel }) {
  if (fromPurchasingCompany) return CHECKOUT_CHANNEL_COMPANY;
  if (existingChannel === CHECKOUT_CHANNEL_COMPANY || existingChannel === CHECKOUT_CHANNEL_CONTACT) {
    return existingChannel;
  }
  if (companyId) return CHECKOUT_CHANNEL_CONTACT;
  return null;
}

module.exports = {
  CHECKOUT_CHANNEL_COMPANY,
  CHECKOUT_CHANNEL_CONTACT,
  normalizeCompanyId,
  normalizeCustomerId,
  resolveCompanyFromContacts,
  orderCompanyId,
  resolveCheckoutChannel,
};
