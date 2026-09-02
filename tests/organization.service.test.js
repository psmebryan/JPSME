// Hierarchy tests for organization.service.js. Runs against the real dev
// database (same approach as tests/paymongo.service.test.js — this project has
// no test framework), creating a clearly-tagged fixture tree and removing it
// afterward in a finally block so a failure mid-run still cleans up.
//
// Covers the variable-depth cases that still matter: a unit under a province,
// a unit with no province recorded, and a province with no units — all in one
// tree, since real PSME data mixes them under the same root.

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
  //    ├── Province A
  //    │     ├── Unit A-1      (TEST 1: National > Province > Unit)
  //    │     └── Unit A-2
  //    ├── Province B          (TEST 3: province with no units)
  //    └── Unit Loose          (TEST 2: unit with no province recorded)

  // Only one root may exist. When the real hierarchy has already been
  // imported, hang the fixture off that root instead of creating a competing
  // one (the "only one root" rule below is what forbids a second). The tests
  // then exercise the same shapes either way.
  const existingRoot = await prisma.organization.findFirst({ where: { parentId: null } });
  const national = existingRoot
    || await orgService.createOrganization({ name: `${TAG} National`, type: 'NATIONAL', parentId: null });
  const provinceA = await orgService.createOrganization({ name: `${TAG} Province A`, type: 'PROVINCE', parentId: national.id });
  const provinceB = await orgService.createOrganization({ name: `${TAG} Province B`, type: 'PROVINCE', parentId: national.id });
  const unitA1 = await orgService.createOrganization({ name: `${TAG} Unit A-1`, type: 'STUDENT_UNIT', parentId: provinceA.id });
  const unitA2 = await orgService.createOrganization({ name: `${TAG} Unit A-2`, type: 'STUDENT_UNIT', parentId: provinceA.id });
  // A unit whose province was never recorded attaches straight to National —
  // the level is absent, not padded with a placeholder.
  const unitLoose = await orgService.createOrganization({ name: `${TAG} Unit Loose`, type: 'STUDENT_UNIT', parentId: national.id });

  // ---- TEST 1-4: the four required hierarchy shapes -----------------------

  await test('TEST 1 — National > Province > Student Unit', async () => {
    const chain = await orgService.getOrganizationPath(unitA1.id);
    assertEqual(chain.length, 3, 'expected a 3-level chain');
    assertEqual(chain.map((o) => o.type).join(','), 'NATIONAL,PROVINCE,STUDENT_UNIT', 'type order');
    assertEqual(chain[0].id, national.id, 'root first');
    assertEqual(chain[2].id, unitA1.id, 'self last');
  });

  await test('TEST 2 — National > Student Unit (no province recorded)', async () => {
    const chain = await orgService.getOrganizationPath(unitLoose.id);
    assertEqual(chain.length, 2, 'expected a 2-level chain');
    assertEqual(chain.map((o) => o.type).join(','), 'NATIONAL,STUDENT_UNIT', 'province level absent, not blank');
    assert(!chain.some((o) => o.type === 'PROVINCE'), 'no placeholder province invented');
  });

  await test('TEST 3 — National > Province (no units beneath)', async () => {
    const chain = await orgService.getOrganizationPath(provinceB.id);
    assertEqual(chain.length, 2, 'expected a 2-level chain');
    assertEqual(chain.map((o) => o.type).join(','), 'NATIONAL,PROVINCE', 'type order');
    const kids = await orgService.getChildren(provinceB.id);
    assertEqual(kids.length, 0, 'province legitimately has no children');
  });

  await test('TEST 4 — a province holds several units', async () => {
    const kids = await orgService.getChildren(provinceA.id);
    assertEqual(kids.length, 2, 'both units sit under province A');
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

  await test('TEST 5 — user assigned directly to a Province', async () => {
    const u = await makeUser('province', provinceB.id);
    const chain = await orgService.getOrganizationPath(u.organizationId);
    assertEqual(chain[chain.length - 1].type, 'PROVINCE', 'affiliated at province level');
    assertEqual(chain.length, 2, 'ancestors resolve');
  });

  await test('TEST 6 — user assigned to a unit with no province', async () => {
    const u = await makeUser('loose', unitLoose.id);
    const chain = await orgService.getOrganizationPath(u.organizationId);
    assertEqual(chain[chain.length - 1].type, 'STUDENT_UNIT', 'affiliated at unit level');
    assertEqual(chain.length, 2, 'National > Student Unit');
  });

  await test('TEST 7 — user assigned to a Student Unit', async () => {
    const u = await makeUser('unit', unitA1.id);
    const label = await orgService.getOrganizationPathLabel(u.organizationId);
    assert(label.includes('National') && label.includes('Unit A-1'), `path label should span root to unit, got: ${label}`);
    assertEqual(label.split(' › ').length, 3, 'label spans National > Province > Unit');
  });

  // ---- TEST 8-10: hierarchy functions -------------------------------------

  await test('TEST 8 — getAncestors() is root-first and excludes self', async () => {
    const ancestors = await orgService.getAncestors(unitA1.id);
    assertEqual(ancestors.length, 2, 'National and the province sit above the unit');
    assertEqual(ancestors[0].id, national.id, 'root first');
    assert(!ancestors.some((a) => a.id === unitA1.id), 'self excluded');
  });

  await test('TEST 9 — getDescendants() returns the subtree without siblings', async () => {
    const desc = await orgService.getDescendants(provinceA.id);
    const ids = desc.map((d) => d.id);
    assert(ids.includes(unitA1.id) && ids.includes(unitA2.id), 'includes both units beneath it');
    assert(!ids.includes(provinceB.id), 'excludes the sibling province subtree');
    assert(!ids.includes(unitLoose.id), 'excludes a unit hanging off National directly');
    assert(!ids.includes(provinceA.id), 'excludes self');
    assertEqual(desc.length, 2, 'exactly the two descendants');
  });

  await test('TEST 10 — getOrganizationPath() returns only levels that exist', async () => {
    const deep = await orgService.getOrganizationPath(unitA1.id);
    const shallow = await orgService.getOrganizationPath(provinceB.id);
    assertEqual(deep.length, 3, 'branch with a province has 3');
    assertEqual(shallow.length, 2, 'branch without one has 2 — no padding to match the deeper branch');
  });

  // ---- TEST 11 + 14: RBAC subtree scoping ---------------------------------

  await test('TEST 11 — org scope covers self plus all descendants', async () => {
    const scope = await orgService.getDescendantIds(provinceA.id);
    assert(scope.includes(provinceA.id), 'scope includes the admin\'s own org');
    assert(scope.includes(unitA1.id), 'scope reaches the deepest descendant');
    assertEqual(scope.length, 3, 'self + 2 descendants');
  });

  await test('TEST 14 — scope excludes a sibling subtree (no cross-org access)', async () => {
    const scopeA = await orgService.getDescendantIds(provinceA.id);
    assert(!scopeA.includes(provinceB.id), 'a Province A admin cannot see Province B');
    assert(!scopeA.includes(unitLoose.id), 'nor a unit outside their subtree');
    // A province with no units scopes to exactly itself.
    const scopeLeaf = await orgService.getDescendantIds(provinceB.id);
    assertEqual(scopeLeaf.length, 1, 'a childless province scopes to exactly itself');
  });

  // ---- TEST 13: historical registration snapshot --------------------------

  await test('TEST 13 — registration organization survives the member moving orgs', async () => {
    const user = await makeUser('snapshot', unitA2.id);
    const event = await prisma.event.create({
      data: { title: `${TAG} Snapshot Event`, startDate: new Date(Date.now() + 86400000) },
    });
    const labelAtRegistration = await orgService.getOrganizationPathLabel(unitA2.id);
    const reg = await prisma.eventRegistration.create({
      data: {
        userId: user.id, eventId: event.id,
        fullName: `${TAG} Snapshot User`, email: user.email,
        organizationId: unitA2.id, organizationPath: labelAtRegistration,
      },
    });

    // The member later transfers to a completely different branch.
    await prisma.user.update({ where: { id: user.id }, data: { organizationId: provinceB.id } });

    const after = await prisma.eventRegistration.findUnique({ where: { id: reg.id } });
    assertEqual(after.organizationId, unitA2.id, 'snapshot FK unchanged by the move');
    assertEqual(after.organizationPath, labelAtRegistration, 'snapshot label unchanged');
    const current = await prisma.user.findUnique({ where: { id: user.id } });
    assertEqual(current.organizationId, provinceB.id, 'user did actually move');
    assert(after.organizationId !== current.organizationId, 'history and current affiliation genuinely differ');
  });

  // ---- TEST 15: pagination / filtering still bounded ----------------------

  await test('TEST 15 — admin listing is paginated and filterable', async () => {
    // 9 tagged orgs below the root, plus a tagged root only when this run had
    // to create one (i.e. the real hierarchy hasn't been imported yet).
    const expectedTotal = 5 + (existingRoot ? 0 : 1);
    const page1 = await orgService.listForAdmin({ q: TAG, page: 1, pageSize: 4 });
    assertEqual(page1.organizations.length, 4, 'page size respected');
    assertEqual(page1.total, expectedTotal, 'total counts the whole fixture tree');
    assertEqual(page1.totalPages, Math.ceil(expectedTotal / 4), 'pages computed');
    const filtered = await orgService.listForAdmin({ q: TAG, type: 'STUDENT_UNIT' });
    assertEqual(filtered.total, 3, 'type filter applied server-side');
  });

  await test('TEST 15b — search returns a resolved path label', async () => {
    const res = await orgService.searchOrganizations({ q: `${TAG} Unit A-1` });
    assert(res.organizations.length >= 1, 'search finds the unit');
    const hit = res.organizations.find((o) => o.id === unitA1.id);
    assert(hit && hit.pathLabel.split(' › ').length === 3, `search result carries full path, got: ${hit && hit.pathLabel}`);
  });

  // ---- Cycle prevention + move ------------------------------------------

  await test('EXTRA — moving an org beneath its own descendant is rejected', async () => {
    let threw = false;
    try {
      await orgService.moveOrganization(provinceA.id, unitA1.id);
    } catch (err) {
      threw = true;
      assert(/descendant/i.test(err.message), `expected a cycle error, got: ${err.message}`);
    }
    assert(threw, 'a cycle-creating move must be rejected');
  });

  await test('EXTRA — an org cannot be its own parent', async () => {
    let threw = false;
    try { await orgService.moveOrganization(provinceA.id, provinceA.id); } catch (err) { threw = true; }
    assert(threw, 'self-parenting must be rejected');
  });

  await test('EXTRA — a legitimate move rewrites the whole subtree path', async () => {
    // Move Unit A-1 from Province A over to Province B.
    await orgService.moveOrganization(unitA1.id, provinceB.id);
    const movedChain = await orgService.getOrganizationPath(unitA1.id);
    assertEqual(movedChain.map((o) => o.type).join(','), 'NATIONAL,PROVINCE,STUDENT_UNIT', 'unit now hangs off Province B');
    assertEqual(movedChain.length, 3, 'depth updated with its new parent');
    assert(movedChain.some((o) => o.id === provinceB.id), 'unit now under Province B');
    assert(!movedChain.some((o) => o.id === provinceA.id), 'unit no longer under the old province');
    // Move it back so later assertions about the tree stay meaningful.
    await orgService.moveOrganization(unitA1.id, provinceA.id);
  });

  await test('EXTRA — path integrity check finds no drift after moves', async () => {
    const { problems } = await orgService.verifyPathIntegrity();
    const ours = problems.filter((p) => p.id);
    assertEqual(ours.length, 0, `expected no path/depth drift, got: ${JSON.stringify(ours.slice(0, 3))}`);
  });

  await test('EXTRA — deleting an org with children is refused', async () => {
    let threw = false;
    try { await orgService.deleteOrganization(provinceA.id); } catch (err) {
      threw = true;
      assert(/child/i.test(err.message), `expected a children error, got: ${err.message}`);
    }
    assert(threw, 'must refuse to orphan children');
  });

  await test('EXTRA — subtree member aggregation counts descendants', async () => {
    // Province A's subtree holds the 'unit' user, who sits on Unit A-1 — a
    // level below the province, which is the point: the count has to reach
    // members it does not hold directly. The 'snapshot' user started on
    // Unit A-2 here but TEST 13 moved them to Province B.
    const countA = await orgService.countMembersInSubtree(provinceA.id);
    assertEqual(countA, 1, 'counts a member sitting a level below the province');
    // Unit A-2 is empty by this point — TEST 13's member moved off it.
    const countLeaf = await orgService.countMembersInSubtree(unitA2.id);
    assertEqual(countLeaf, 0, 'a unit with no members counts zero');
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
