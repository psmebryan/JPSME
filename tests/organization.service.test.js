// Hierarchy tests for organization.service.js. Runs against the real dev
// database (same approach as tests/paymongo.service.test.js — this project has
// no test framework), creating a clearly-tagged fixture tree and removing it
// afterward in a finally block so a failure mid-run still cleans up.
//
// Covers the variable-depth cases that motivated the redesign: a full
// five-level branch, a branch with no cluster, a cluster with no chapter, and
// a chapter with no student unit — all in one tree, since real PSME data mixes
// them under the same root.

const prisma = require('../src/config/prisma');
const orgService = require('../src/services/organization.service');

const TAG = '__ORGTEST__';
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(`  ${err.message}`);
    failed += 1;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

async function cleanup() {
  // Children before parents — organizations.parentId is onDelete: Restrict.
  await prisma.eventRegistration.deleteMany({ where: { fullName: { contains: TAG } } });
  await prisma.event.deleteMany({ where: { title: { contains: TAG } } });
  await prisma.user.deleteMany({ where: { email: { contains: 'orgtest-' } } });
  const orgs = await prisma.organization.findMany({
    where: { name: { contains: TAG } },
    orderBy: { depth: 'desc' },
    select: { id: true },
  });
  // eslint-disable-next-line no-restricted-syntax
  for (const o of orgs) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.organization.delete({ where: { id: o.id } }).catch(() => {});
  }
}

async function run() {
  await cleanup(); // clear residue from any previous aborted run

  // ---- Fixture tree -------------------------------------------------------
  //
  //  National
  //    ├── Region A
  //    │     ├── Cluster A1
  //    │     │     └── Chapter A1a
  //    │     │           └── Unit A1a-1        (TEST 1: full 5 levels)
  //    │     └── Chapter A2                    (TEST 2: no cluster)
  //    │           └── Unit A2-1
  //    └── Region B
  //          ├── Cluster B1                    (TEST 3: cluster, no chapter)
  //          └── Chapter B2                    (TEST 4: chapter, no unit)

  // Only one root may exist. When the real hierarchy has already been
  // imported, hang the fixture off that root instead of creating a competing
  // one (the "only one root" rule below is what forbids a second). The tests
  // then exercise the same shapes either way.
  const existingRoot = await prisma.organization.findFirst({ where: { parentId: null } });
  const national = existingRoot
    || await orgService.createOrganization({ name: `${TAG} National`, type: 'NATIONAL', parentId: null });
  const regionA = await orgService.createOrganization({ name: `${TAG} Region A`, type: 'REGION', parentId: national.id });
  const regionB = await orgService.createOrganization({ name: `${TAG} Region B`, type: 'REGION', parentId: national.id });
  const clusterA1 = await orgService.createOrganization({ name: `${TAG} Cluster A1`, type: 'CLUSTER', parentId: regionA.id });
  const chapterA1a = await orgService.createOrganization({ name: `${TAG} Chapter A1a`, type: 'CHAPTER', parentId: clusterA1.id });
  const unitA1a1 = await orgService.createOrganization({ name: `${TAG} Unit A1a-1`, type: 'STUDENT_UNIT', parentId: chapterA1a.id });
  const chapterA2 = await orgService.createOrganization({ name: `${TAG} Chapter A2`, type: 'CHAPTER', parentId: regionA.id });
  const unitA21 = await orgService.createOrganization({ name: `${TAG} Unit A2-1`, type: 'STUDENT_UNIT', parentId: chapterA2.id });
  const clusterB1 = await orgService.createOrganization({ name: `${TAG} Cluster B1`, type: 'CLUSTER', parentId: regionB.id });
  const chapterB2 = await orgService.createOrganization({ name: `${TAG} Chapter B2`, type: 'CHAPTER', parentId: regionB.id });

  // ---- TEST 1-4: the four required hierarchy shapes -----------------------

  await test('TEST 1 — National > Region > Cluster > Chapter > Student Unit', async () => {
    const chain = await orgService.getOrganizationPath(unitA1a1.id);
    assertEqual(chain.length, 5, 'expected a 5-level chain');
    assertEqual(chain.map((o) => o.type).join(','), 'NATIONAL,REGION,CLUSTER,CHAPTER,STUDENT_UNIT', 'type order');
    assertEqual(chain[0].id, national.id, 'root first');
    assertEqual(chain[4].id, unitA1a1.id, 'self last');
  });

  await test('TEST 2 — National > Region > Chapter > Student Unit (no cluster)', async () => {
    const chain = await orgService.getOrganizationPath(unitA21.id);
    assertEqual(chain.length, 4, 'expected a 4-level chain');
    assertEqual(chain.map((o) => o.type).join(','), 'NATIONAL,REGION,CHAPTER,STUDENT_UNIT', 'cluster level absent, not blank');
    assert(!chain.some((o) => o.type === 'CLUSTER'), 'no placeholder cluster invented');
  });

  await test('TEST 3 — National > Region > Cluster (no chapter beneath)', async () => {
    const chain = await orgService.getOrganizationPath(clusterB1.id);
    assertEqual(chain.length, 3, 'expected a 3-level chain');
    assertEqual(chain.map((o) => o.type).join(','), 'NATIONAL,REGION,CLUSTER', 'type order');
    const kids = await orgService.getChildren(clusterB1.id);
    assertEqual(kids.length, 0, 'cluster legitimately has no children');
  });

  await test('TEST 4 — National > Region > Chapter (no student unit)', async () => {
    const chain = await orgService.getOrganizationPath(chapterB2.id);
    assertEqual(chain.length, 3, 'expected a 3-level chain');
    assertEqual(chain.map((o) => o.type).join(','), 'NATIONAL,REGION,CHAPTER', 'type order');
    const kids = await orgService.getChildren(chapterB2.id);
    assertEqual(kids.length, 0, 'chapter legitimately has no children');
  });

  // ---- TEST 5-7: users attach at whichever level is correct ---------------

  async function makeUser(suffix, organizationId) {
    return prisma.user.create({
      data: {
        firstName: 'Org', lastName: `Test ${suffix}`,
        email: `orgtest-${suffix}@example.invalid`,
        password: 'x', role: 'USER', status: 'APPROVED', organizationId,
      },
    });
  }

  await test('TEST 5 — user assigned directly to a Cluster', async () => {
    const u = await makeUser('cluster', clusterB1.id);
    const chain = await orgService.getOrganizationPath(u.organizationId);
    assertEqual(chain[chain.length - 1].type, 'CLUSTER', 'affiliated at cluster level');
    assertEqual(chain.length, 3, 'ancestors resolve');
  });

  await test('TEST 6 — user assigned directly to a Chapter', async () => {
    const u = await makeUser('chapter', chapterA2.id);
    const chain = await orgService.getOrganizationPath(u.organizationId);
    assertEqual(chain[chain.length - 1].type, 'CHAPTER', 'affiliated at chapter level');
    assertEqual(chain.length, 3, 'National > Region > Chapter');
  });

  await test('TEST 7 — user assigned to a Student Unit', async () => {
    const u = await makeUser('unit', unitA1a1.id);
    const label = await orgService.getOrganizationPathLabel(u.organizationId);
    assert(label.includes('National') && label.includes('Unit A1a-1'), `path label should span root to unit, got: ${label}`);
    assertEqual(label.split(' › ').length, 5, 'label has all five levels');
  });

  // ---- TEST 8-10: hierarchy functions -------------------------------------

  await test('TEST 8 — getAncestors() is root-first and excludes self', async () => {
    const ancestors = await orgService.getAncestors(unitA1a1.id);
    assertEqual(ancestors.length, 4, 'four ancestors above the unit');
    assertEqual(ancestors[0].id, national.id, 'root first');
    assert(!ancestors.some((a) => a.id === unitA1a1.id), 'self excluded');
  });

  await test('TEST 9 — getDescendants() returns the subtree without siblings', async () => {
    const desc = await orgService.getDescendants(regionA.id);
    const ids = desc.map((d) => d.id);
    assert(ids.includes(clusterA1.id) && ids.includes(chapterA1a.id) && ids.includes(unitA1a1.id), 'includes deep descendants');
    assert(ids.includes(chapterA2.id) && ids.includes(unitA21.id), 'includes the no-cluster branch');
    assert(!ids.includes(regionB.id) && !ids.includes(clusterB1.id), 'excludes the sibling region subtree');
    assert(!ids.includes(regionA.id), 'excludes self');
    assertEqual(desc.length, 5, 'exactly the five descendants');
  });

  await test('TEST 10 — getOrganizationPath() returns only levels that exist', async () => {
    const deep = await orgService.getOrganizationPath(unitA1a1.id);
    const shallow = await orgService.getOrganizationPath(clusterB1.id);
    assertEqual(deep.length, 5, 'deep branch has 5');
    assertEqual(shallow.length, 3, 'shallow branch has 3 — no padding to match the deep one');
  });

  // ---- TEST 11 + 14: RBAC subtree scoping ---------------------------------

  await test('TEST 11 — org scope covers self plus all descendants', async () => {
    const scope = await orgService.getDescendantIds(regionA.id);
    assert(scope.includes(regionA.id), 'scope includes the admin\'s own org');
    assert(scope.includes(unitA1a1.id), 'scope reaches the deepest descendant');
    assertEqual(scope.length, 6, 'self + 5 descendants');
  });

  await test('TEST 14 — scope excludes a sibling subtree (no cross-org access)', async () => {
    const scopeA = await orgService.getDescendantIds(regionA.id);
    assert(!scopeA.includes(regionB.id), 'Region A admin cannot see Region B');
    assert(!scopeA.includes(clusterB1.id), 'nor its cluster');
    assert(!scopeA.includes(chapterB2.id), 'nor its chapter');
    // And a leaf chapter's scope is just itself.
    const scopeLeaf = await orgService.getDescendantIds(chapterB2.id);
    assertEqual(scopeLeaf.length, 1, 'a childless chapter scopes to exactly itself');
  });

  // ---- TEST 13: historical registration snapshot --------------------------

  await test('TEST 13 — registration organization survives the member moving orgs', async () => {
    const user = await makeUser('snapshot', chapterA2.id);
    const event = await prisma.event.create({
      data: { title: `${TAG} Snapshot Event`, startDate: new Date(Date.now() + 86400000) },
    });
    const labelAtRegistration = await orgService.getOrganizationPathLabel(chapterA2.id);
    const reg = await prisma.eventRegistration.create({
      data: {
        userId: user.id, eventId: event.id,
        fullName: `${TAG} Snapshot User`, email: user.email,
        organizationId: chapterA2.id, organizationPath: labelAtRegistration,
      },
    });

    // The member later transfers to a completely different branch.
    await prisma.user.update({ where: { id: user.id }, data: { organizationId: clusterB1.id } });

    const after = await prisma.eventRegistration.findUnique({ where: { id: reg.id } });
    assertEqual(after.organizationId, chapterA2.id, 'snapshot FK unchanged by the move');
    assertEqual(after.organizationPath, labelAtRegistration, 'snapshot label unchanged');
    const current = await prisma.user.findUnique({ where: { id: user.id } });
    assertEqual(current.organizationId, clusterB1.id, 'user did actually move');
    assert(after.organizationId !== current.organizationId, 'history and current affiliation genuinely differ');
  });

  // ---- TEST 15: pagination / filtering still bounded ----------------------

  await test('TEST 15 — admin listing is paginated and filterable', async () => {
    // 9 tagged orgs below the root, plus a tagged root only when this run had
    // to create one (i.e. the real hierarchy hasn't been imported yet).
    const expectedTotal = 9 + (existingRoot ? 0 : 1);
    const page1 = await orgService.listForAdmin({ q: TAG, page: 1, pageSize: 4 });
    assertEqual(page1.organizations.length, 4, 'page size respected');
    assertEqual(page1.total, expectedTotal, 'total counts the whole fixture tree');
    assertEqual(page1.totalPages, Math.ceil(expectedTotal / 4), 'pages computed');
    const filtered = await orgService.listForAdmin({ q: TAG, type: 'CHAPTER' });
    assertEqual(filtered.total, 3, 'type filter applied server-side');
  });

  await test('TEST 15b — search returns a resolved path label', async () => {
    const res = await orgService.searchOrganizations({ q: `${TAG} Unit A1a-1` });
    assert(res.organizations.length >= 1, 'search finds the unit');
    const hit = res.organizations.find((o) => o.id === unitA1a1.id);
    assert(hit && hit.pathLabel.split(' › ').length === 5, `search result carries full path, got: ${hit && hit.pathLabel}`);
  });

  // ---- Cycle prevention + move ------------------------------------------

  await test('EXTRA — moving an org beneath its own descendant is rejected', async () => {
    let threw = false;
    try {
      await orgService.moveOrganization(regionA.id, unitA1a1.id);
    } catch (err) {
      threw = true;
      assert(/descendant/i.test(err.message), `expected a cycle error, got: ${err.message}`);
    }
    assert(threw, 'a cycle-creating move must be rejected');
  });

  await test('EXTRA — an org cannot be its own parent', async () => {
    let threw = false;
    try { await orgService.moveOrganization(regionA.id, regionA.id); } catch (err) { threw = true; }
    assert(threw, 'self-parenting must be rejected');
  });

  await test('EXTRA — a legitimate move rewrites the whole subtree path', async () => {
    // Move Chapter A1a (and its unit) from Cluster A1 over to Region B.
    await orgService.moveOrganization(chapterA1a.id, regionB.id);
    const movedChain = await orgService.getOrganizationPath(chapterA1a.id);
    assertEqual(movedChain.map((o) => o.type).join(','), 'NATIONAL,REGION,CHAPTER', 'chapter now hangs off region B');
    // The descendant must have moved with it.
    const unitChain = await orgService.getOrganizationPath(unitA1a1.id);
    assertEqual(unitChain.length, 4, 'unit depth updated with its parent');
    assert(unitChain.some((o) => o.id === regionB.id), 'unit now under Region B');
    assert(!unitChain.some((o) => o.id === clusterA1.id), 'unit no longer under the old cluster');
    // Move it back so later assertions about the tree stay meaningful.
    await orgService.moveOrganization(chapterA1a.id, clusterA1.id);
  });

  await test('EXTRA — path integrity check finds no drift after moves', async () => {
    const { problems } = await orgService.verifyPathIntegrity();
    const ours = problems.filter((p) => p.id);
    assertEqual(ours.length, 0, `expected no path/depth drift, got: ${JSON.stringify(ours.slice(0, 3))}`);
  });

  await test('EXTRA — deleting an org with children is refused', async () => {
    let threw = false;
    try { await orgService.deleteOrganization(regionA.id); } catch (err) {
      threw = true;
      assert(/child/i.test(err.message), `expected a children error, got: ${err.message}`);
    }
    assert(threw, 'must refuse to orphan children');
  });

  await test('EXTRA — subtree member aggregation counts descendants', async () => {
    // Region A subtree currently holds the 'chapter', 'unit' and 'snapshot'
    // users... minus 'snapshot', which moved to Cluster B1 in TEST 13.
    const countA = await orgService.countMembersInSubtree(regionA.id);
    assertEqual(countA, 2, 'aggregates members across the whole Region A subtree');
    const countLeaf = await orgService.countMembersInSubtree(chapterB2.id);
    assertEqual(countLeaf, 0, 'a childless chapter with no members counts zero');
  });

  await test('EXTRA — only one root organization is permitted', async () => {
    let threw = false;
    try {
      await orgService.createOrganization({ name: `${TAG} Second Root`, type: 'NATIONAL', parentId: null });
    } catch (err) { threw = true; assert(/root/i.test(err.message), err.message); }
    assert(threw, 'a second root must be rejected');
  });
}

run()
  .catch((err) => { console.error('\nTest run crashed:', err); failed += 1; })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
    console.log(`\n${passed} passed, ${failed} failed.`);
    if (failed > 0) process.exit(1);
    console.log('All organization hierarchy tests passed.');
  });
