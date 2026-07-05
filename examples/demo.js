// Run `npx eslint examples/` (or `npx eslint examples/ --fix`) to see the
// rule in action. Every function below contains at least one finding.

export async function fullyIndependent() {
  const user = await fetch('/api/user');
  const posts = await fetch('/api/posts');
  return { user, posts };
}

export async function partialDependency(id) {
  const user = await fetchUser(id);
  const settings = await fetchSettings(id);
  const feed = await buildFeed(user, settings);
  return feed;
}

export async function diamond() {
  const base = await loadBase();
  const left = await expandLeft(base);
  const right = await expandRight(base);
  return await merge(left, right);
}

export async function booleanLogic(user) {
  return (await isAdmin(user)) && (await hasQuota(user));
}

export async function independentLoop(items) {
  const out = [];
  for (const item of items) {
    out.push(await fetchUser(item)); // flagged: iterations are independent
  }
  return out;
}

export async function pagingLoop(fetchPage) {
  const all = [];
  let token;
  do {
    const page = await fetchPage(token); // silent: loop-carried dependency
    all.push(page.items);
    token = page.next;
  } while (token);
  return all;
}

async function fetchUser(id) {
  return fetch(`/api/user/${id}`);
}
async function fetchSettings(id) {
  return fetch(`/api/settings/${id}`);
}
async function buildFeed(user, settings) {
  return { user, settings };
}
async function loadBase() {}
async function expandLeft() {}
async function expandRight() {}
async function merge() {}
async function isAdmin() {}
async function hasQuota() {}
