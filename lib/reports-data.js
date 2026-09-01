'use strict';

const { shopifyGraphql, isAccessDenied } = require('./shopify-gql');

const COMPANIES_WITH_STAFF = `
  query ReportCompanies($first: Int!, $after: String) {
    companies(first: $first, after: $after) {
      edges {
        node {
          id
          name
          locations(first: 20) {
            edges {
              node {
                id
                name
                staffMemberAssignments(first: 20) {
                  edges {
                    node {
                      staffMember { id firstName lastName email }
                    }
                  }
                }
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const COMPANIES_ASSIGNMENT_IDS = `
  query ReportCompanies($first: Int!, $after: String) {
    companies(first: $first, after: $after) {
      edges {
        node {
          id
          name
          locations(first: 20) {
            edges {
              node {
                id
                name
                staffMemberAssignments(first: 20) {
                  edges { node { id } }
                }
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const RECENT_ORDERS = `
  query RecentB2bOrders($first: Int!, $after: String) {
    orders(first: $first, after: $after, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          id
          createdAt
          totalPriceSet { shopMoney { amount currencyCode } }
          purchasingEntity {
            __typename
            ... on PurchasingCompany {
              company { id name }
              location { id name }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const LOCATIONS_QUERY = `
  query getMetaobjects($first: Int!, $after: String) {
    metaobjects(type: "b2b_map_location", first: $first, after: $after) {
      edges {
        node {
          fields { key value }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

async function paginate(client, query, rootKey, maxPages, label) {
  const nodes = [];
  let after = null;
  let truncated = false;
  for (let page = 0; page < maxPages; page += 1) {
    const data = await shopifyGraphql(client, query, { first: 50, after }, label);
    const conn = data?.[rootKey];
    if (!conn) break;
    const edges = conn.edges || [];
    for (const edge of edges) nodes.push(edge.node);
    if (!conn.pageInfo?.hasNextPage) return { nodes, truncated };
    after = conn.pageInfo.endCursor;
  }
  truncated = true;
  return { nodes, truncated };
}

function staffLabel(assignment) {
  const member = assignment?.staffMember;
  if (!member) return 'Assigned';
  const name = [member.firstName, member.lastName].filter(Boolean).join(' ').trim();
  return name || member.email || 'Assigned';
}

function summarizeCompanies(companies) {
  const staffCounts = new Map();
  let assigned = 0;
  const rows = companies.map((company) => {
    const names = [];
    for (const locEdge of company.locations?.edges || []) {
      for (const assignEdge of locEdge.node.staffMemberAssignments?.edges || []) {
        const label = staffLabel(assignEdge.node);
        names.push(label);
        staffCounts.set(label, (staffCounts.get(label) || 0) + 1);
      }
    }
    const unique = [...new Set(names)];
    if (unique.length) assigned += 1;
    return {
      id: company.id,
      name: company.name,
      staff: unique,
      assigned: unique.length > 0,
    };
  });
  return {
    total: companies.length,
    assigned,
    unassigned: companies.length - assigned,
    rows,
    staff: [...staffCounts.entries()]
      .map(([name, accounts]) => ({ name, accounts }))
      .sort((a, b) => b.accounts - a.accounts),
  };
}

function summarizeOrders(orders) {
  const byCompany = new Map();
  let revenue = 0;
  let currency = 'USD';
  let b2bCount = 0;
  for (const order of orders) {
    const amount = parseFloat(order.totalPriceSet?.shopMoney?.amount || '0') || 0;
    revenue += amount;
    currency = order.totalPriceSet?.shopMoney?.currencyCode || currency;
    const company = order.purchasingEntity?.company;
    if (order.purchasingEntity?.__typename === 'PurchasingCompany' && company) {
      b2bCount += 1;
      const current = byCompany.get(company.id) || { id: company.id, name: company.name, orders: 0, revenue: 0 };
      current.orders += 1;
      current.revenue += amount;
      byCompany.set(company.id, current);
    }
  }
  return {
    orderCount: orders.length,
    b2bCount,
    revenue,
    currency,
    topCompanies: [...byCompany.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 10),
  };
}

function summarizeLocations(locationNodes) {
  let synced = 0;
  for (const node of locationNodes) {
    const fields = {};
    for (const field of node.fields || []) fields[field.key] = field.value;
    if (fields.latitude && fields.longitude) synced += 1;
  }
  return {
    total: locationNodes.length,
    synced,
    missing: locationNodes.length - synced,
  };
}

async function fetchCompanies(client) {
  try {
    return await paginate(client, COMPANIES_WITH_STAFF, 'companies', 8, 'report companies');
  } catch (err) {
    if (!isAccessDenied(err)) throw err;
    return paginate(client, COMPANIES_ASSIGNMENT_IDS, 'companies', 8, 'report companies');
  }
}

async function buildReportSummary(client) {
  const [companiesPage, ordersPage, locationsPage] = await Promise.all([
    fetchCompanies(client),
    paginate(client, RECENT_ORDERS, 'orders', 2, 'report orders'),
    paginate(client, LOCATIONS_QUERY, 'metaobjects', 6, 'report locations'),
  ]);

  return {
    companies: summarizeCompanies(companiesPage.nodes),
    orders: summarizeOrders(ordersPage.nodes),
    locations: summarizeLocations(locationsPage.nodes),
    truncated: {
      companies: companiesPage.truncated,
      orders: ordersPage.truncated,
      locations: locationsPage.truncated,
    },
  };
}

module.exports = {
  buildReportSummary,
};
