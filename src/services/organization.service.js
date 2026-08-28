const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');

// Variable-depth organization tree. Depth is data (parentId + a materialized
// `path`), never schema — National → Region → Cluster → Chapter → Student Unit
// and National → Region → Chapter are equally valid, and neither needs a
// placeholder row to fill a "missing" level.
//
// `path` is the performance mechanism: it stores every ancestor id inline as
// "/1/4/9/" so a whole subtree is one indexed `path LIKE '/1/4/%'` query and a
// full ancestor chain is one `id IN (...)`. Without it, RBAC (which resolves a
// subtree on every scoped admin request) would be a recursive per-level walk.
// The cost is that reparenting rewrites the moved subtree's paths — a rare
// admin action, always inside a transaction.

const PATH_SEPARATOR = '/';

function buildPath(parentPath, id) {
  return `${parentPath}${id}${PATH_SEPARATOR}`;
}

// "/1/4/9/" -> [1, 4, 9]. Self is included; callers strip it when they want
// strict ancestors.
function parsePathIds(path) {
  return String(path || '')
    .split(PATH_SEPARATOR)
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n));
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 180);
}

// Slugs are @unique; the official workbook contains genuinely duplicated
// organization names, so collisions are expected rather than exceptional.
async function uniqueSlug(baseName, client = prisma) {
  const base = slugify(baseName) || 'organization';
  let candidate = base;
  let n = 2;
  // eslint-disable-next-line no-await-in-loop
  while (await client.organization.findUnique({ where: { slug: candidate }, select: { id: true } })) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  return candidate;
}

// --- Reads ---

async function getOrganization(id) {
  return prisma.organization.findUnique({ where: { id: Number(id) } });
}

async function getOrganizationOrThrow(id) {
  const org = await getOrganization(id);
  if (!org) throw new AppError('Organization not found', 404);
  return org;
}

// Direct children only — one indexed query on parentId. This is what the
// admin tree UI expands with, so a large tree is never loaded wholesale.
async function getChildren(id, { activeOnly = false } = {}) {
  return prisma.organization.findMany({
    where: { parentId: Number(id), ...(activeOnly ? { isActive: true } : {}) },
    orderBy: [{ order: 'asc' }, { name: 'asc' }],
  });
}

// Strict ancestors, root-first, excluding the organization itself.
async function getAncestors(id) {
  const org = await getOrganizationOrThrow(id);
  const ids = parsePathIds(org.path).filter((n) => n !== org.id);
  if (!ids.length) return [];
  const rows = await prisma.organization.findMany({ where: { id: { in: ids } } });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((i) => byId.get(i)).filter(Boolean);
}

// Whole subtree, excluding self. One indexed prefix scan.
async function getDescendants(id, { activeOnly = false } = {}) {
  const org = await getOrganizationOrThrow(id);
  return prisma.organization.findMany({
    where: {
      path: { startsWith: org.path },
      id: { not: org.id },
      ...(activeOnly ? { isActive: true } : {}),
    },
    orderBy: [{ depth: 'asc' }, { order: 'asc' }, { name: 'asc' }],
  });
}

// Subtree ids INCLUDING self — the shape RBAC and reporting aggregation want.
// id-only select keeps this cheap even for the national root.
async function getDescendantIds(id) {
  const org = await getOrganization(id);
  if (!org) return [];
  const rows = await prisma.organization.findMany({
    where: { path: { startsWith: org.path } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

// Ancestors + self, root-first. Only the levels that actually exist — a unit
// hanging directly off a region returns 3 entries, not 5 with blanks.
async function getOrganizationPath(id) {
  const org = await getOrganizationOrThrow(id);
  const ancestors = await getAncestors(id);
  return [...ancestors, org];
}

// Human-readable label frozen onto EventRegistration at registration time.
async function getOrganizationPathLabel(id, separator = ' › ') {
  const chain = await getOrganizationPath(id);
  return chain.map((o) => o.name).join(separator);
}

// --- Search / admin listing (server-side paginated, per the 5K work) ---

// Registration's organization picker: the member searches instead of choosing
// a level at a time, so they never have to know their own hierarchy.
async function searchOrganizations({ q, type, page = 1, pageSize = 20 } = {}) {
  const where = { isActive: true };
  const term = String(q || '').trim();
  if (term) {
    where.OR = [{ name: { contains: term } }, { institution: { contains: term } }];
  }
  if (type) where.type = type;

  const [total, organizations] = await Promise.all([
    prisma.organization.count({ where }),
    prisma.organization.findMany({
      where,
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  // One extra query resolves every result's ancestor chain, so the picker can
  // show the full path without an N+1 lookup per row.
  const allIds = new Set();
  organizations.forEach((o) => parsePathIds(o.path).forEach((i) => allIds.add(i)));
  const ancestorRows = allIds.size
    ? await prisma.organization.findMany({ where: { id: { in: [...allIds] } }, select: { id: true, name: true } })
    : [];
  const nameById = new Map(ancestorRows.map((r) => [r.id, r.name]));

  return {
    organizations: organizations.map((o) => ({
      ...o,
      pathLabel: parsePathIds(o.path).map((i) => nameById.get(i)).filter(Boolean).join(' › '),
    })),
    total,
    page,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

async function listForAdmin({ q, type, parentId, needsReview, page = 1, pageSize = 25 } = {}) {
  const where = {};
  const term = String(q || '').trim();
  if (term) where.OR = [{ name: { contains: term } }, { institution: { contains: term } }];
  if (type) where.type = type;
  if (parentId !== undefined && parentId !== null && parentId !== '') where.parentId = Number(parentId);
  if (needsReview === true) where.needsReview = true;

  const [total, organizations] = await Promise.all([
    prisma.organization.count({ where }),
    prisma.organization.findMany({
      where,
      orderBy: [{ depth: 'asc' }, { order: 'asc' }, { name: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { _count: { select: { children: true, users: true } } },
    }),
  ]);

  return { organizations, total, page, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

// --- Reporting ---

// Members counted across the whole subtree: an org's own members plus every
// descendant's. Works at any depth, so a cluster with no chapters aggregates
// exactly as correctly as one with chapters and units beneath it.
async function countMembersInSubtree(id, { status = 'APPROVED' } = {}) {
  const ids = await getDescendantIds(id);
  if (!ids.length) return 0;
  return prisma.user.count({
    where: { organizationId: { in: ids }, role: 'USER', ...(status ? { status } : {}) },
  });
}

// --- Writes ---

async function createOrganization({
  name, type, parentId = null, code = null, institution = null,
  email = null, facebookUrl = null, subRegion = null, yearFounded = null,
  isActive = true, order = 0, needsReview = false, importNote = null, sourceSheet = null,
}, client = prisma) {
  if (!name || !String(name).trim()) throw new AppError('Organization name is required', 400);
  if (!type) throw new AppError('Organization type is required', 400);

  let parent = null;
  if (parentId !== null && parentId !== undefined) {
    parent = await client.organization.findUnique({ where: { id: Number(parentId) } });
    if (!parent) throw new AppError('Parent organization not found', 404);
  } else {
    // Exactly one root. Everything else must hang off something.
    const existingRoot = await client.organization.findFirst({ where: { parentId: null } });
    if (existingRoot) {
      throw new AppError(`A root organization already exists (${existingRoot.name}). Provide a parentId.`, 409);
    }
  }

  const slug = await uniqueSlug(name, client);
  const created = await client.organization.create({
    data: {
      name: String(name).trim(),
      slug,
      code,
      type,
      parentId: parent ? parent.id : null,
      path: PATH_SEPARATOR, // rewritten immediately below, once the id exists
      depth: parent ? parent.depth + 1 : 0,
      institution, email, facebookUrl, subRegion, yearFounded,
      isActive, order, needsReview, importNote, sourceSheet,
    },
  });

  // path embeds the row's own id, so it can only be computed post-insert.
  return client.organization.update({
    where: { id: created.id },
    data: { path: buildPath(parent ? parent.path : PATH_SEPARATOR, created.id) },
  });
}

async function updateOrganization(id, data) {
  const org = await getOrganizationOrThrow(id);
  const allowed = {};
  ['name', 'code', 'type', 'institution', 'email', 'facebookUrl', 'subRegion', 'isActive', 'order', 'needsReview', 'importNote'].forEach((k) => {
    if (Object.prototype.hasOwnProperty.call(data, k)) allowed[k] = data[k];
  });
  if (Object.prototype.hasOwnProperty.call(data, 'yearFounded')) {
    allowed.yearFounded = data.yearFounded === '' || data.yearFounded === null ? null : Number(data.yearFounded);
  }
  if (allowed.name && allowed.name !== org.name) {
    allowed.slug = await uniqueSlug(allowed.name);
  }
  return prisma.organization.update({ where: { id: org.id }, data: allowed });
}

// Moving a subtree. Rejects cycles, then rewrites every descendant's path and
// depth in the same transaction so path can never drift from parentId.
async function moveOrganization(id, newParentId) {
  const org = await getOrganizationOrThrow(id);

  if (newParentId === null || newParentId === undefined) {
    throw new AppError('An organization must have a parent (only the national root may have none)', 400);
  }
  if (Number(newParentId) === org.id) {
    throw new AppError('An organization cannot be its own parent', 400);
  }

  const newParent = await prisma.organization.findUnique({ where: { id: Number(newParentId) } });
  if (!newParent) throw new AppError('Parent organization not found', 404);

  // The cycle check, made cheap by the materialized path: if the proposed
  // parent sits inside this organization's own subtree, its path starts with
  // this organization's path. Blocks A → B → C → A.
  if (newParent.path.startsWith(org.path)) {
    throw new AppError('Cannot move an organization beneath one of its own descendants', 400);
  }

  return prisma.$transaction(async (tx) => {
    const oldPath = org.path;
    const newPath = buildPath(newParent.path, org.id);
    const depthShift = (newParent.depth + 1) - org.depth;

    const subtree = await tx.organization.findMany({
      where: { path: { startsWith: oldPath } },
      select: { id: true, path: true, depth: true },
    });

    // eslint-disable-next-line no-restricted-syntax
    for (const node of subtree) {
      // eslint-disable-next-line no-await-in-loop
      await tx.organization.update({
        where: { id: node.id },
        data: {
          path: newPath + node.path.slice(oldPath.length),
          depth: node.depth + depthShift,
          ...(node.id === org.id ? { parentId: newParent.id } : {}),
        },
      });
    }

    return tx.organization.findUnique({ where: { id: org.id } });
  });
}

async function deleteOrganization(id) {
  const org = await getOrganizationOrThrow(id);
  const childCount = await prisma.organization.count({ where: { parentId: org.id } });
  if (childCount > 0) {
    throw new AppError(`This organization has ${childCount} child organization(s). Move or delete them first.`, 409);
  }
  const memberCount = await prisma.user.count({ where: { organizationId: org.id } });
  if (memberCount > 0) {
    throw new AppError(`This organization has ${memberCount} member(s). Reassign them first.`, 409);
  }
  await prisma.organization.delete({ where: { id: org.id } });
  return { deleted: true };
}

// --- Integrity ---

// Recomputes every path/depth from parentId alone and reports disagreements.
// Guards against the one real risk of a materialized path: silent drift.
async function verifyPathIntegrity() {
  const all = await prisma.organization.findMany({ select: { id: true, parentId: true, path: true, depth: true } });
  const byId = new Map(all.map((o) => [o.id, o]));
  const problems = [];

  all.forEach((org) => {
    const chain = [];
    let cursor = org;
    const seen = new Set();
    while (cursor) {
      if (seen.has(cursor.id)) { chain.length = 0; problems.push({ id: org.id, issue: 'cycle detected' }); break; }
      seen.add(cursor.id);
      chain.unshift(cursor.id);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : null;
    }
    if (!chain.length) return;
    const expectedPath = `${PATH_SEPARATOR}${chain.join(PATH_SEPARATOR)}${PATH_SEPARATOR}`;
    const expectedDepth = chain.length - 1;
    if (org.path !== expectedPath) problems.push({ id: org.id, issue: 'path mismatch', expected: expectedPath, actual: org.path });
    if (org.depth !== expectedDepth) problems.push({ id: org.id, issue: 'depth mismatch', expected: expectedDepth, actual: org.depth });
  });

  return { checked: all.length, problems };
}

module.exports = {
  getOrganization,
  getOrganizationOrThrow,
  getChildren,
  getAncestors,
  getDescendants,
  getDescendantIds,
  getOrganizationPath,
  getOrganizationPathLabel,
  searchOrganizations,
  listForAdmin,
  countMembersInSubtree,
  createOrganization,
  updateOrganization,
  moveOrganization,
  deleteOrganization,
  verifyPathIntegrity,
  parsePathIds,
  slugify,
};
