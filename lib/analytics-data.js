'use strict';

const { shopifyGraphql } = require('./shopify-gql');

/**
 * GraphQL query to fetch companies with revenue and order data
 * @type {string}
 */
const COMPANIES_REVENUE_QUERY = `
  query getCompaniesAnalytics($first: Int!, $after: String) {
    companies(first: $first, after: $after) {
      edges {
        node {
          id
          name
          externalId
          createdAt
          customerSince
          updatedAt
          totalSpent {
            amount
            currencyCode
          }
          ordersCount {
            count
          }
          recentOrders: orders(first: 20, reverse: true) {
            edges {
              node {
                id
                createdAt
                currentTotalPriceSet {
                  shopMoney {
                    amount
                  }
                }
              }
            }
          }
          contacts(first: 5) {
            edges {
              node {
                customer {
                  id
                  numberOfOrders
                  lastOrder {
                    createdAt
                  }
                }
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/**
 * GraphQL query to fetch recent orders with pricing
 * @type {string}
 */
const RECENT_ORDERS_QUERY = `
  query getRecentOrders($first: Int!, $after: String) {
    orders(first: $first, after: $after, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          id
          createdAt
          lineItems(first: 100) {
            edges {
              node {
                id
                title
                sku
                quantity
                originalTotalSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
          currentTotalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          purchasingEntity {
            __typename
            ... on PurchasingCompany {
              company {
                id
                name
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/**
 * Company names and contacts only — no orders or lifetime spend.
 * Used when order rollups already have revenue / last-order numbers.
 */
const COMPANIES_DIRECTORY_QUERY = `
  query AnalyticsCompaniesDirectory($first: Int!, $after: String) {
    companies(first: $first, after: $after) {
      edges {
        node {
          id
          name
          externalId
          createdAt
          customerSince
          contacts(first: 5) {
            edges {
              node {
                id
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const COMPANY_PROFILE_QUERY = `
  query AnalyticsCompanyProfile($id: ID!) {
    company(id: $id) {
      id
      name
      externalId
      createdAt
      customerSince
      contacts(first: 50) {
        edges {
          node {
            id
          }
        }
      }
    }
  }
`;

const COMPANIES_COUNT_QUERY = `
  query AnalyticsCompaniesCount {
    companiesCount {
      count
    }
  }
`;

/**
 * GraphQL query to fetch products with variant information
 * @type {string}
 */
const PRODUCTS_QUERY = `
  query getProducts($first: Int!, $after: String) {
    products(first: $first, after: $after, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          id
          title
          handle
          createdAt
          updatedAt
          status
          totalInventory
          variants(first: 100) {
            edges {
              node {
                id
                title
                sku
                price
                inventoryQuantity
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/**
 * Paginate through Shopify GraphQL results
 * @param {Object} client - Shopify GraphQL client
 * @param {string} query - GraphQL query string
 * @param {string} rootKey - Root key in the response (e.g., 'companies', 'orders')
 * @param {number} maxPages - Maximum pages to fetch
 * @param {string} label - Label for logging
 * @returns {Promise<{nodes: Array, truncated: boolean}>}
 */
async function paginate(client, query, rootKey, maxPages, label) {
  const nodes = [];
  let after = null;
  let truncated = false;

  for (let page = 0; page < maxPages; page += 1) {
    const data = await shopifyGraphql(client, query, { first: 50, after }, label);
    const conn = data?.[rootKey];
    if (!conn) break;

    const edges = conn.edges || [];
    for (const edge of edges) {
      nodes.push(edge.node);
    }

    if (!conn.pageInfo?.hasNextPage) {
      return { nodes, truncated };
    }
    after = conn.pageInfo.endCursor;
  }

  truncated = true;
  return { nodes, truncated };
}

/**
 * Calculate revenue summary across all companies
 * @param {Array} companies - Array of company objects from Shopify
 * @returns {Object} Revenue summary with frontend field names
 */
function calculateRevenueSummary(companies) {
  let totalRevenue = 0;
  let totalOrders = 0;
  let activeCompanies = 0;
  let currency = 'USD';

  for (const company of companies) {
    const spent = parseFloat(company.totalSpent?.amount || '0') || 0;
    const ordersCount = parseInt(company.ordersCount?.count || '0', 10) || 0;

    if (spent > 0 || ordersCount > 0) {
      activeCompanies += 1;
    }

    totalRevenue += spent;
    totalOrders += ordersCount;
    currency = company.totalSpent?.currencyCode || currency;
  }

  return {
    revenue: parseFloat(totalRevenue.toFixed(2)),  // Changed from totalRevenue
    orders: totalOrders,  // Changed from totalOrders
    activeCompanies,
    totalCompanies: companies.length,
    currencyCode: currency,  // Changed from currency
    avgOrderValue: totalOrders > 0 ? parseFloat((totalRevenue / totalOrders).toFixed(2)) : 0,  // Changed from averageOrderValue
  };
}

/**
 * Group orders by date for trend analysis with optional date range filtering
 * @param {Array} orders - Array of order objects
 * @param {string} period - Period grouping: 'daily', 'weekly', 'monthly'
 * @param {string} startDate - Optional ISO 8601 start date (inclusive)
 * @param {string} endDate - Optional ISO 8601 end date (inclusive)
 * @returns {Object} Grouped revenue data
 */
function calculateRevenueTrend(orders, period = 'daily', startDate = null, endDate = null) {
  const startTime = startDate ? new Date(startDate).getTime() : null;
  const endTime = endDate ? new Date(endDate).getTime() : null;

  const trends = new Map();
  let totalRevenue = 0;
  let currency = 'USD';

  for (const order of orders) {
    const orderDate = new Date(order.createdAt);
    const orderTime = orderDate.getTime();

    // Apply date range filter
    if (startTime !== null && orderTime < startTime) continue;
    if (endTime !== null && orderTime > endTime) continue;

    let key;
    if (period === 'daily') {
      key = orderDate.toISOString().split('T')[0];
    } else if (period === 'weekly') {
      const weekStart = new Date(orderDate);
      weekStart.setDate(orderDate.getDate() - orderDate.getDay());
      key = weekStart.toISOString().split('T')[0];
    } else if (period === 'monthly') {
      key = orderDate.toISOString().slice(0, 7);
    } else {
      key = orderDate.toISOString().split('T')[0];
    }

    const amount = parseFloat(order.currentTotalPriceSet?.shopMoney?.amount || '0') || 0;
    currency = order.currentTotalPriceSet?.shopMoney?.currencyCode || currency;

    if (!trends.has(key)) {
      trends.set(key, { date: key, revenue: 0, orders: 0 });
    }

    const trend = trends.get(key);
    trend.revenue += amount;
    trend.orders += 1;
    totalRevenue += amount;
  }

  const sorted = Array.from(trends.values()).sort((a, b) => a.date.localeCompare(b.date));

  return {
    trends: sorted.map(t => ({
      date: t.date,
      revenue: parseFloat(t.revenue.toFixed(2)),
      orders: t.orders,
    })),
    totalRevenue: parseFloat(totalRevenue.toFixed(2)),
    currencyCode: currency,  // Changed from currency
    period,
  };
}

/**
 * Build company-level analytics
 * @param {Array} companies - Array of company objects
 * @returns {Array} Companies with analytics
 */
function buildCompanyAnalytics(companies) {
  return companies
    .map((company) => {
      const totalSpent = parseFloat(company.totalSpent?.amount || '0') || 0;
      const ordersCount = parseInt(company.ordersCount?.count || '0', 10) || 0;

      // Get recent order dates
      const orderDates = (company.recentOrders?.edges || [])
        .map(e => e?.node?.createdAt)
        .filter(Boolean);

      let lastOrderDate = null;
      let daysSinceLastOrder = null;
      let avgOrderValue = 0;

      if (orderDates.length > 0) {
        lastOrderDate = new Date(Math.max(...orderDates.map(d => new Date(d).getTime()))).toISOString();
        daysSinceLastOrder = Math.floor((Date.now() - new Date(lastOrderDate).getTime()) / (1000 * 60 * 60 * 24));
      }

      if (ordersCount > 0) {
        avgOrderValue = parseFloat((totalSpent / ordersCount).toFixed(2));
      }

      return {
        id: company.id,
        name: company.name,
        externalId: company.externalId || null,
        createdAt: company.createdAt,
        customerSince: company.customerSince,
        totalSpent: parseFloat(totalSpent.toFixed(2)),
        ordersCount,
        lastOrderDate,
        daysSinceLastOrder,
        avgOrderValue,
        currency: company.totalSpent?.currencyCode || 'USD',
        contactCount: company.contacts?.edges?.length || 0,
      };
    })
    .sort((a, b) => b.totalSpent - a.totalSpent);
}

/**
 * Build product-level analytics
 * @param {Array} products - Array of product objects
 * @returns {Array} Products with analytics
 */
function buildProductAnalytics(products) {
  return products.map((product) => {
    const variants = product.variants?.edges || [];
    const totalInventory = variants.reduce((sum, edge) => {
      return sum + (parseInt(edge.node?.inventoryQuantity || '0', 10) || 0);
    }, 0);

    return {
      id: product.id,
      title: product.title,
      handle: product.handle,
      status: product.status,
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
      totalInventory,
      variantCount: variants.length,
      variantSkus: variants
        .map(edge => edge.node?.sku)
        .filter(Boolean),
    };
  });
}

/**
 * Calculate top product by revenue from orders
 * @param {Array} orders - Array of order objects with lineItems
 * @param {string} startDate - Optional ISO 8601 start date (inclusive)
 * @param {string} endDate - Optional ISO 8601 end date (inclusive)
 * @returns {Object|null} Top product with { id, title, revenue, quantity } or null if no products
 */
function calculateTopProduct(orders, startDate = null, endDate = null) {
  const startTime = startDate ? new Date(startDate).getTime() : null;
  const endTime = endDate ? new Date(endDate).getTime() : null;

  const productMetrics = new Map();

  for (const order of orders) {
    const orderDate = new Date(order.createdAt);
    const orderTime = orderDate.getTime();

    // Apply date range filter
    if (startTime !== null && orderTime < startTime) continue;
    if (endTime !== null && orderTime > endTime) continue;

    const lineItems = order.lineItems?.edges || [];
    for (const itemEdge of lineItems) {
      const item = itemEdge?.node;
      if (!item) continue;

      const productId = item.product?.id || `unknown_${Math.random()}`;
      const productTitle = item.product?.title || item.title || 'Unknown Product';
      const quantity = item.quantity || 0;
      const revenue = parseFloat(item.originalTotalSet?.shopMoney?.amount || '0') || 0;

      if (!productMetrics.has(productId)) {
        productMetrics.set(productId, {
          id: productId,
          title: productTitle,
          revenue: 0,
          quantity: 0,
        });
      }

      const metrics = productMetrics.get(productId);
      metrics.revenue += revenue;
      metrics.quantity += quantity;
    }
  }

  if (productMetrics.size === 0) return null;

  // Convert to array and sort by revenue descending
  const products = Array.from(productMetrics.values())
    .sort((a, b) => b.revenue - a.revenue);

  return {
    id: products[0].id,
    title: products[0].title,
    revenue: parseFloat(products[0].revenue.toFixed(2)),
    quantity: products[0].quantity,
  };
}

/**
 * Build analytics summary combining companies and orders
 * @param {Object} client - Shopify GraphQL client
 * @param {string} startDate - Optional ISO 8601 start date (inclusive)
 * @param {string} endDate - Optional ISO 8601 end date (inclusive)
 * @returns {Promise<Object>} Analytics summary with topProduct
 */
async function buildAnalyticsSummary(client, startDate = null, endDate = null) {
  const [companiesPage, ordersPage] = await Promise.all([
    paginate(client, COMPANIES_REVENUE_QUERY, 'companies', 10, 'analytics companies'),
    paginate(client, RECENT_ORDERS_QUERY, 'orders', 5, 'analytics orders'),
  ]);

  const revenueSummary = calculateRevenueSummary(companiesPage.nodes);
  const trend = calculateRevenueTrend(ordersPage.nodes, 'daily', startDate, endDate);
  const topProduct = calculateTopProduct(ordersPage.nodes, startDate, endDate);

  return {
    summary: {
      ...revenueSummary,
      topProduct,  // Add topProduct to summary
    },
    trend,
    generatedAt: new Date().toISOString(),
    truncated: {
      companies: companiesPage.truncated,
      orders: ordersPage.truncated,
    },
  };
}

/**
 * Sort company analytics rows without mutating the source array.
 */
function sortCompanyAnalytics(analytics, sortBy = 'revenue', sortOrder = 'desc') {
  const list = Array.isArray(analytics) ? [...analytics] : [];
  if (sortBy === 'name') {
    list.sort((a, b) => (sortOrder === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name)));
  } else if (sortBy === 'createdAt') {
    list.sort((a, b) => (sortOrder === 'asc'
      ? new Date(a.createdAt) - new Date(b.createdAt)
      : new Date(b.createdAt) - new Date(a.createdAt)));
  } else {
    list.sort((a, b) => (sortOrder === 'asc' ? a.totalSpent - b.totalSpent : b.totalSpent - a.totalSpent));
  }
  return list;
}

/**
 * Overlay date-range rollup metrics onto a Shopify company directory.
 * `totalSpent` is the selected-range revenue so existing charts keep working.
 */
function mergeCompaniesWithRange(directoryCompanies, rangeMap) {
  return (directoryCompanies || []).map((company) => {
    const metrics = rangeMap instanceof Map ? rangeMap.get(company.id) || {} : {};
    const totalSpent = parseFloat(metrics.totalSpend || 0) || 0;
    const ordersCount = parseInt(metrics.orderCount || 0, 10) || 0;
    const lastOrderDate = metrics.lastOrderDate || null;
    const daysSinceLastOrder = metrics.daysSinceLastOrder != null
      ? metrics.daysSinceLastOrder
      : (lastOrderDate
        ? Math.floor((Date.now() - new Date(lastOrderDate).getTime()) / (1000 * 60 * 60 * 24))
        : null);
    return {
      id: company.id,
      name: company.name,
      externalId: company.externalId || null,
      createdAt: company.createdAt,
      customerSince: company.customerSince || null,
      totalSpent: parseFloat(totalSpent.toFixed(2)),
      ordersCount,
      lastOrderDate,
      daysSinceLastOrder,
      avgOrderValue: ordersCount > 0 ? parseFloat((totalSpent / ordersCount).toFixed(2)) : 0,
      currency: 'USD',
      contactCount: company.contactCount
        ?? company.contacts?.edges?.length
        ?? 0,
    };
  });
}

async function fetchCompaniesDirectory(client, maxPages = 20) {
  return paginate(client, COMPANIES_DIRECTORY_QUERY, 'companies', maxPages, 'analytics company directory');
}

async function fetchCompanyProfile(client, companyId) {
  const data = await shopifyGraphql(client, COMPANY_PROFILE_QUERY, { id: companyId }, 'analytics company profile');
  return data?.company || null;
}

async function fetchCompaniesCount(client) {
  const data = await shopifyGraphql(client, COMPANIES_COUNT_QUERY, {}, 'analytics companies count');
  const count = parseInt(data?.companiesCount?.count, 10);
  return Number.isFinite(count) ? count : 0;
}

/**
 * Get all companies with analytics data with optional date range filtering
 * @param {Object} client - Shopify GraphQL client
 * @param {Object} options - Query options (maxPages, sortBy, sortOrder, startDate, endDate)
 * @returns {Promise<Object>} Companies with analytics
 */
async function getCompaniesAnalytics(client, options = {}) {
  const { maxPages = 10, sortBy = 'revenue', sortOrder = 'desc' } = options;

  const companiesPage = await paginate(client, COMPANIES_REVENUE_QUERY, 'companies', maxPages, 'analytics companies');
  const analytics = sortCompanyAnalytics(buildCompanyAnalytics(companiesPage.nodes), sortBy, sortOrder);

  return {
    companies: analytics,
    totalCount: companiesPage.nodes.length,
    truncated: companiesPage.truncated,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Get single company analytics by ID
 * @param {Object} client - Shopify GraphQL client
 * @param {string} companyId - Company ID
 * @returns {Promise<Object>} Company analytics
 */
async function getCompanyAnalytics(client, companyId) {
  const query = `
    query getCompany($id: ID!) {
      company(id: $id) {
        id
        name
        externalId
        createdAt
        customerSince
        updatedAt
        totalSpent {
          amount
          currencyCode
        }
        ordersCount {
          count
        }
        recentOrders: orders(first: 100, reverse: true) {
          edges {
            node {
              id
              createdAt
              currentTotalPriceSet {
                shopMoney {
                  amount
                }
              }
            }
          }
        }
        contacts(first: 50) {
          edges {
            node {
              id
              customer {
                id
                numberOfOrders
                lastOrder {
                  createdAt
                }
              }
            }
          }
        }
      }
    }
  `;

  const data = await shopifyGraphql(client, query, { id: companyId }, 'analytics company detail');
  const company = data?.company;

  if (!company) {
    return null;
  }

  const totalSpent = parseFloat(company.totalSpent?.amount || '0') || 0;
  const ordersCount = parseInt(company.ordersCount?.count || '0', 10) || 0;

  const orderDates = (company.recentOrders?.edges || [])
    .map(e => e?.node?.createdAt)
    .filter(Boolean);

  let lastOrderDate = null;
  let daysSinceLastOrder = null;
  let avgOrderValue = 0;

  if (orderDates.length > 0) {
    lastOrderDate = new Date(Math.max(...orderDates.map(d => new Date(d).getTime()))).toISOString();
    daysSinceLastOrder = Math.floor((Date.now() - new Date(lastOrderDate).getTime()) / (1000 * 60 * 60 * 24));
  }

  if (ordersCount > 0) {
    avgOrderValue = parseFloat((totalSpent / ordersCount).toFixed(2));
  }

  // Build order trend for this company
  const orderTrend = {};
  for (const edge of company.recentOrders?.edges || []) {
    const date = new Date(edge.node.createdAt).toISOString().split('T')[0];
    if (!orderTrend[date]) {
      orderTrend[date] = { date, revenue: 0, orders: 0 };
    }
    const amount = parseFloat(edge.node.currentTotalPriceSet?.shopMoney?.amount || '0') || 0;
    orderTrend[date].revenue += amount;
    orderTrend[date].orders += 1;
  }

  return {
    id: company.id,
    name: company.name,
    externalId: company.externalId || null,
    createdAt: company.createdAt,
    customerSince: company.customerSince,
    totalSpent: parseFloat(totalSpent.toFixed(2)),
    ordersCount,
    lastOrderDate,
    daysSinceLastOrder,
    avgOrderValue,
    currency: company.totalSpent?.currencyCode || 'USD',
    contactCount: company.contacts?.edges?.length || 0,
    orderTrend: Object.values(orderTrend).sort((a, b) => a.date.localeCompare(b.date)),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Get products analytics based on revenue metrics from orders
 * @param {Object} client - Shopify GraphQL client
 * @param {Object} options - Query options (maxPages, startDate, endDate)
 * @returns {Promise<Object>} Products analytics with revenue-based metrics
 */
async function getProductsAnalytics(client, options = {}) {
  const { maxPages = 10, startDate = null, endDate = null } = options;

  // Fetch ALL orders using paginateOrders
  const ordersResult = await paginateOrders(client, RECENT_ORDERS_QUERY, 'orders', maxPages, 'analytics products');

  if (ordersResult.error) {
    throw ordersResult.error;
  }

  // Apply date range filtering if specified
  let filteredOrders = ordersResult.nodes;
  if (startDate || endDate) {
    const startTime = startDate ? new Date(startDate).getTime() : null;
    const endTime = endDate ? new Date(endDate).getTime() : null;

    filteredOrders = ordersResult.nodes.filter((order) => {
      const orderTime = new Date(order.createdAt).getTime();
      if (startTime !== null && orderTime < startTime) return false;
      if (endTime !== null && orderTime > endTime) return false;
      return true;
    });
  }

  // Call aggregateProductMetrics on the order data to get revenue metrics
  const productMetrics = aggregateProductMetrics(filteredOrders);

  // Transform the output to match expected schema with revenue-based fields
  const products = (productMetrics.allProducts || []).map((product) => ({
    id: product.productId,
    title: product.title,
    revenue: product.revenue,
    quantitySold: product.unitsSold,
    unitsSold: product.unitsSold,
    avgUnitPrice: product.avgUnitPrice,
    orderCount: product.orderCount,
    currencyCode: product.currencyCode,
  }));

  return {
    products,
    generatedAt: new Date().toISOString(),
    truncated: ordersResult.truncated,
  };
}

/**
 * Get revenue trend data for specified period with optional date range filtering
 * @param {Object} client - Shopify GraphQL client
 * @param {Object} options - Query options (period, maxPages, startDate, endDate)
 * @returns {Promise<Object>} Revenue trend
 */
async function getRevenueTrend(client, options = {}) {
  const { period = 'daily', maxPages = 10, startDate = null, endDate = null } = options;

  const ordersPage = await paginate(client, RECENT_ORDERS_QUERY, 'orders', maxPages, 'analytics revenue trend');
  const trend = calculateRevenueTrend(ordersPage.nodes, period, startDate, endDate);

  return {
    ...trend,
    truncated: ordersPage.truncated,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Pagination helper - alias for paginate with error handling.
 * Handles cursor-based pagination with configurable page limit.
 *
 * @param {Object} client - Shopify GraphQL client
 * @param {string} query - GraphQL query string
 * @param {string} rootKey - Root key for the connection (e.g., 'orders', 'companies')
 * @param {number} maxPages - Maximum number of pages to fetch (default: 10)
 * @param {string} label - Label for logging/debugging
 * @returns {Promise<Object>} Object with { nodes: Array, truncated: boolean, error: Error|null }
 */
async function paginateOrders(client, query, rootKey, maxPages = 10, label = 'pagination') {
  try {
    const result = await paginate(client, query, rootKey, maxPages, label);
    return { ...result, error: null };
  } catch (err) {
    return { nodes: [], truncated: true, error: err };
  }
}

/**
 * Aggregates revenue and order metrics for a single company with date range filtering.
 * Groups orders by date and calculates running totals.
 *
 * @param {Array} orders - Array of order objects from Shopify GraphQL
 * @param {string} companyId - The company ID to filter orders
 * @param {string} startDate - Optional ISO 8601 start date (inclusive)
 * @param {string} endDate - Optional ISO 8601 end date (inclusive)
 * @returns {Object} Aggregated metrics including totalRevenue, orderCount, avgOrderValue, lastOrderDate, etc.
 */
function aggregateCompanyMetrics(orders, companyId, startDate = null, endDate = null) {
  const startTime = startDate ? new Date(startDate).getTime() : null;
  const endTime = endDate ? new Date(endDate).getTime() : null;

  const companyOrders = orders.filter((order) => {
    if (order.purchasingEntity?.company?.id !== companyId) return false;

    // Apply date range filter
    const orderTime = new Date(order.createdAt).getTime();
    if (startTime !== null && orderTime < startTime) return false;
    if (endTime !== null && orderTime > endTime) return false;

    return true;
  });

  if (companyOrders.length === 0) {
    return {
      companyId,
      totalRevenue: 0,
      orderCount: 0,
      avgOrderValue: 0,
      lastOrderDate: null,
      firstOrderDate: null,
      currencyCode: 'USD',
      dates: [],
      byDate: {},
    };
  }

  let totalRevenue = 0;
  let currencyCode = 'USD';
  const byDate = {};
  const dates = [];

  for (const order of companyOrders) {
    const amount = parseFloat(order.currentTotalPriceSet?.shopMoney?.amount || '0') || 0;
    totalRevenue += amount;
    currencyCode = order.currentTotalPriceSet?.shopMoney?.currencyCode || currencyCode;

    const orderDate = order.createdAt
      ? new Date(order.createdAt).toISOString().split('T')[0]
      : 'unknown';

    if (!byDate[orderDate]) {
      byDate[orderDate] = { date: orderDate, count: 0, revenue: 0 };
      dates.push(orderDate);
    }
    byDate[orderDate].count += 1;
    byDate[orderDate].revenue += amount;
  }

  dates.sort();

  return {
    companyId,
    totalRevenue: parseFloat(totalRevenue.toFixed(2)),
    orderCount: companyOrders.length,
    avgOrderValue: parseFloat((totalRevenue / companyOrders.length).toFixed(2)),
    lastOrderDate: companyOrders[0]?.createdAt || null,
    firstOrderDate: companyOrders[companyOrders.length - 1]?.createdAt || null,
    currencyCode,
    dates,
    byDate,
  };
}

/**
 * Aggregates metrics across all companies with date range filtering.
 * Returns rollup statistics and per-company breakdowns.
 *
 * @param {Array} orders - Array of all orders
 * @param {Array} companies - Array of company objects
 * @param {string} startDate - Optional ISO 8601 start date (inclusive)
 * @param {string} endDate - Optional ISO 8601 end date (inclusive)
 * @returns {Object} Aggregated metrics for all companies including topCompanies, totalMetrics, etc.
 */
function aggregateAllCompanies(orders, companies, startDate = null, endDate = null) {
  const companyMap = new Map(companies.map((c) => [c.id, c]));
  const companyMetrics = [];

  // Calculate metrics for each company
  for (const company of companies) {
    const metrics = aggregateCompanyMetrics(orders, company.id, startDate, endDate);
    companyMetrics.push({
      ...metrics,
      name: company.name || 'Unknown',
      locationCount: company.locations?.edges?.length || 0,
    });
  }

  // Sort by revenue descending
  companyMetrics.sort((a, b) => b.totalRevenue - a.totalRevenue);

  // Calculate totals
  const totalRevenue = companyMetrics.reduce((sum, m) => sum + m.totalRevenue, 0);
  const totalOrders = companyMetrics.reduce((sum, m) => sum + m.orderCount, 0);
  const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;

  return {
    totalCompanies: companyMetrics.length,
    totalRevenue: parseFloat(totalRevenue.toFixed(2)),
    totalOrders,
    avgOrderValue: parseFloat(avgOrderValue.toFixed(2)),
    topCompanies: companyMetrics.slice(0, 10),
    allCompanies: companyMetrics,
    currencyCode: companyMetrics[0]?.currencyCode || 'USD',
  };
}

/**
 * Aggregates product performance metrics from orders.
 * Calculates units sold, revenue, and average order value per product.
 *
 * @param {Array} orders - Array of orders with lineItems
 * @returns {Object} Product metrics including topProducts, totalSKUs, etc.
 */
function aggregateProductMetrics(orders) {
  const byProduct = new Map();

  for (const order of orders) {
    const lineItems = order.lineItems?.edges || [];

    for (const itemEdge of lineItems) {
      const item = itemEdge?.node;
      if (!item) continue;

      const productId = item.product?.id || 'unknown';
      const productTitle = item.product?.title || item.title || 'Unknown';
      const sku = item.variant?.sku || 'no-sku';
      const quantity = item.quantity || 0;
      const amount = parseFloat(item.originalTotalSet?.shopMoney?.amount || '0') || 0;
      const currencyCode = item.originalTotalSet?.shopMoney?.currencyCode || 'USD';

      if (!byProduct.has(productId)) {
        byProduct.set(productId, {
          productId,
          title: productTitle,
          skus: new Set(),
          unitsSold: 0,
          revenue: 0,
          currencyCode,
          orderCount: 0,
        });
      }

      const metrics = byProduct.get(productId);
      metrics.skus.add(sku);
      metrics.unitsSold += quantity;
      metrics.revenue += amount;
      metrics.orderCount += 1;
    }
  }

  // Convert to array and calculate derived metrics
  const productMetrics = Array.from(byProduct.values()).map((m) => ({
    productId: m.productId,
    title: m.title,
    skuCount: m.skus.size,
    unitsSold: m.unitsSold,
    revenue: parseFloat(m.revenue.toFixed(2)),
    currencyCode: m.currencyCode,
    orderCount: m.orderCount,
    avgUnitPrice: m.unitsSold > 0 ? parseFloat((m.revenue / m.unitsSold).toFixed(2)) : 0,
  }));

  // Sort by revenue descending
  productMetrics.sort((a, b) => b.revenue - a.revenue);

  const totalRevenue = productMetrics.reduce((sum, m) => sum + m.revenue, 0);
  const totalUnitsSold = productMetrics.reduce((sum, m) => sum + m.unitsSold, 0);

  return {
    totalProducts: productMetrics.length,
    totalUnitsSold,
    totalRevenue: parseFloat(totalRevenue.toFixed(2)),
    topProducts: productMetrics.slice(0, 20),
    allProducts: productMetrics,
    currencyCode: productMetrics[0]?.currencyCode || 'USD',
  };
}

/**
 * Builds revenue trend data over time with optional date range filtering.
 * Aggregates revenue by day, week, or month based on specified period.
 *
 * @param {Array} orders - Array of orders
 * @param {string} period - 'day', 'week', or 'month' (default: 'day')
 * @param {string} startDate - Optional ISO 8601 start date (inclusive)
 * @param {string} endDate - Optional ISO 8601 end date (inclusive)
 * @param {number} lookbackDays - Number of days to look back (default: 90, ignored if startDate/endDate provided)
 * @returns {Object} Revenue trend with dates and amounts
 */
function buildRevenueTrend(orders, period = 'day', startDate = null, endDate = null, lookbackDays = 90) {
  let startTime = null;
  let endTime = null;

  if (startDate || endDate) {
    // Use explicit date range if provided
    startTime = startDate ? new Date(startDate).getTime() : null;
    endTime = endDate ? new Date(endDate).getTime() : null;
  } else {
    // Fall back to lookbackDays
    const now = new Date();
    const cutoffDate = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
    startTime = cutoffDate.getTime();
  }

  const byPeriod = {};
  let currencyCode = 'USD';

  for (const order of orders) {
    const orderDate = order.createdAt ? new Date(order.createdAt) : null;
    if (!orderDate) continue;

    const orderTime = orderDate.getTime();

    // Apply date range filter
    if (startTime !== null && orderTime < startTime) continue;
    if (endTime !== null && orderTime > endTime) continue;

    const amount = parseFloat(order.currentTotalPriceSet?.shopMoney?.amount || '0') || 0;
    currencyCode = order.currentTotalPriceSet?.shopMoney?.currencyCode || currencyCode;

    let periodKey;
    if (period === 'day') {
      periodKey = orderDate.toISOString().split('T')[0];
    } else if (period === 'week') {
      const weekStart = new Date(orderDate);
      weekStart.setDate(orderDate.getDate() - orderDate.getDay());
      periodKey = weekStart.toISOString().split('T')[0];
    } else if (period === 'month') {
      periodKey = orderDate.toISOString().slice(0, 7); // YYYY-MM
    } else {
      periodKey = orderDate.toISOString().split('T')[0];
    }

    if (!byPeriod[periodKey]) {
      byPeriod[periodKey] = { date: periodKey, revenue: 0, orderCount: 0 };
    }
    byPeriod[periodKey].revenue += amount;
    byPeriod[periodKey].orderCount += 1;
  }

  const trend = Object.values(byPeriod).sort((a, b) => a.date.localeCompare(b.date));

  // Calculate cumulative revenue
  let cumulativeRevenue = 0;
  const withCumulative = trend.map((entry) => {
    cumulativeRevenue += entry.revenue;
    return {
      ...entry,
      revenue: parseFloat(entry.revenue.toFixed(2)),
      cumulativeRevenue: parseFloat(cumulativeRevenue.toFixed(2)),
    };
  });

  return {
    period,
    lookbackDays: startDate || endDate ? null : lookbackDays,  // null when explicit dates used
    trend: withCumulative,
    totalRevenue: parseFloat(cumulativeRevenue.toFixed(2)),
    currencyCode,
    dataPoints: withCumulative.length,
  };
}

/**
 * Exports analytics data as CSV format.
 * Accepts either company or product metrics.
 *
 * @param {Object} data - Analytics data object (companies or products from aggregations)
 * @param {string} type - 'companies' or 'products' (default: 'companies')
 * @returns {string} CSV-formatted string
 */
function exportToCSV(data, type = 'companies') {
  if (type === 'companies') {
    const headers = [
      'Company ID',
      'Company Name',
      'Total Revenue',
      'Order Count',
      'Avg Order Value',
      'Last Order Date',
      'First Order Date',
      'Location Count',
    ];

    const rows = (data.allCompanies || []).map((company) => [
      company.companyId,
      `"${company.name}"`,
      company.totalRevenue.toFixed(2),
      company.orderCount,
      company.avgOrderValue.toFixed(2),
      company.lastOrderDate || 'N/A',
      company.firstOrderDate || 'N/A',
      company.locationCount || 0,
    ]);

    return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  }

  if (type === 'products') {
    const headers = [
      'Product ID',
      'Product Title',
      'SKU Count',
      'Units Sold',
      'Total Revenue',
      'Order Count',
      'Avg Unit Price',
    ];

    const rows = (data.allProducts || []).map((product) => [
      product.productId,
      `"${product.title}"`,
      product.skuCount,
      product.unitsSold,
      product.revenue.toFixed(2),
      product.orderCount,
      product.avgUnitPrice.toFixed(2),
    ]);

    return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  }

  return '';
}

/**
 * Exports analytics data as JSON format.
 * Maintains full fidelity of all numeric values and nested structures.
 *
 * @param {Object} data - Analytics data object
 * @param {boolean} pretty - Whether to pretty-print JSON (default: true)
 * @returns {string} JSON-formatted string
 */
function exportToJSON(data, pretty = true) {
  if (pretty) {
    return JSON.stringify(data, null, 2);
  }
  return JSON.stringify(data);
}

/**
 * Exports revenue trend as CSV format.
 * Includes daily/weekly/monthly breakdown with cumulative totals.
 *
 * @param {Object} trendData - Trend data from buildRevenueTrend()
 * @returns {string} CSV-formatted string
 */
function exportTrendToCSV(trendData) {
  const headers = [
    'Date',
    'Revenue',
    'Order Count',
    'Cumulative Revenue',
  ];

  const rows = (trendData.trend || []).map((entry) => [
    entry.date,
    entry.revenue.toFixed(2),
    entry.orderCount,
    entry.cumulativeRevenue.toFixed(2),
  ]);

  return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
}

module.exports = {
  buildAnalyticsSummary,
  getCompaniesAnalytics,
  getCompanyAnalytics,
  getProductsAnalytics,
  getRevenueTrend,
  fetchCompaniesDirectory,
  fetchCompanyProfile,
  fetchCompaniesCount,
  mergeCompaniesWithRange,
  sortCompanyAnalytics,
  paginate,
  paginateOrders,
  aggregateCompanyMetrics,
  aggregateAllCompanies,
  aggregateProductMetrics,
  buildRevenueTrend,
  calculateTopProduct,
  calculateRevenueTrend,
  calculateRevenueSummary,
  exportToCSV,
  exportToJSON,
  exportTrendToCSV,
};
