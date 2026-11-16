// Offline `github.issues`: a fake broker answering the REST issue search.
// Covers the qualifier policy (ours vs. the model's), that no token value ever
// reaches an answer, an error or the cache key, that a 401 names the variable
// actually in effect, and the 403 rate-limit line.
import { services } from '../module/index.js'
import { clearCache, normaliseItems, readParams, buildQuery, issuesUrl, tokenSource } from '../module/lib/github.js'

delete process.env.Z1_GITHUB_TOKEN
delete process.env.GITHUB_TOKEN
delete process.env.Z1_SEARX_URL
delete process.env.Z1_SEARX_STATE

const TOKEN = 'ghp_SECRET_do_not_echo_1234567890'

let checks = 0
let failures = 0
function check(label, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`ok   ${label}`)
  } else {
    failures += 1
    console.log(`FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

async function errorOf(fn) {
  try {
    await fn()
    return '(no error)'
  } catch (error) {
    return error.message
  }
}

/** Fake broker: records the request, answers whatever `route` returns. */
function broker(route) {
  const requests = []
  const ctx = {
    net: {
      async request(request) {
        requests.push(request)
        return { status: 200, headers: {}, body: '', truncated: false, ...route(request) }
      },
    },
  }
  return { ctx, requests }
}

const reply = (body, status = 200, headers = {}) => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
})

const call = (ctx, args) => services.tools(ctx).call('github.issues', args)

const HITS = {
  total_count: 1523,
  incomplete_results: false,
  items: [
    {
      title: 'Crash when the borrow checker gives up',
      html_url: 'https://github.com/rust-lang/rust/issues/12345',
      state: 'open',
      comments: 4,
      repository_url: 'https://api.github.com/repos/rust-lang/rust',
      updated_at: '2024-03-02T10:00:00Z',
      number: 12345,
    },
    {
      title: 'Closed: another crash',
      html_url: 'https://github.com/rust-lang/rust/issues/999',
      state: 'closed',
      comments: 1,
      repository_url: 'https://api.github.com/repos/rust-lang/rust',
      updated_at: '2024-02-01T10:00:00Z',
      number: 999,
    },
    { title: 'no html_url', state: 'open', comments: 0 },
    { title: '', html_url: 'https://github.com/a/b/issues/1', state: 'open', comments: 0 },
    null,
  ],
}

const queryOf = (request) => new URL(request.url).searchParams.get('q')

// --- qualifier policy: label: survives ------------------------------------

{
  clearCache()
  const { ctx, requests } = broker(() => reply(HITS, 200, {
    'x-ratelimit-remaining': '9',
    'x-ratelimit-limit': '10',
  }))
  const text = await call(ctx, { query: 'label:bug crash' })
  check('label:bug is passed through untouched, as the model wrote it',
    queryOf(requests[0]) === 'label:bug crash state:open is:issue', queryOf(requests[0]))
  check('the search goes to the REST issue endpoint',
    requests[0].url.startsWith('https://api.github.com/search/issues?'), requests[0].url)
  check('the request asks for the JSON media type',
    requests[0].headers.accept === 'application/vnd.github+json' &&
      requests[0].headers['x-github-api-version'] === '2022-11-28',
    JSON.stringify(requests[0].headers))
  check('no Authorization header is sent without a token',
    requests[0].headers.authorization === undefined, JSON.stringify(requests[0].headers))
  check('hits are rendered in API order, malformed ones dropped',
    text.split('\n').filter((line) => /^\d+\. /.test(line)).length === 2, text)
  check('each hit carries repo, state, comments, update and number',
    text.split('\n')[1] === '   rust-lang/rust · open · 4 comments · updated 2024-03-02 · #12345', text.split('\n')[1])
  check('a closed hit says closed',
    text.split('\n')[3] === '   rust-lang/rust · closed · 1 comment · updated 2024-02-01 · #999', text.split('\n')[3])
  check('the footer carries the real count and the rate-limit pair',
    text.split('\n').at(-1) === '(github · 2 of 1523 · 9/10 requests left this minute)', text.split('\n').at(-1))
}

{
  // Other qualifiers the model may use are not stripped either.
  const { ctx, requests } = broker(() => reply(HITS))
  await call(ctx, { query: 'org:rust-lang author:foo milestone:1.80 windows', kind: 'any', state: 'all' })
  check('user qualifiers all survive the strip',
    queryOf(requests[0]) === 'org:rust-lang author:foo milestone:1.80 windows', queryOf(requests[0]))
  check('kind:any and state:all add no is:/state: qualifier',
    !/is:|state:/.test(queryOf(requests[0])), queryOf(requests[0]))
}

// --- qualifier policy: repo:/state:/is: are ours --------------------------

{
  const params = readParams({
    query: 'is:issue repo:evil/repo state:closed crash',
    repo: 'rust-lang/rust',
    state: 'open',
    kind: 'issue',
  })
  check('repo:, state: and is: typed into the query are stripped',
    params.q === 'repo:rust-lang/rust crash state:open is:issue', params.q)
  check('the tool sends exactly one repo: qualifier',
    (params.q.match(/repo:/g) ?? []).length === 1, params.q)
  check('buildQuery puts repo first, then the words, then state and kind',
    buildQuery({ query: 'crash', repo: 'a/b', state: 'closed', kind: 'pr' }) === 'repo:a/b crash state:closed is:pr')
  check('a query of only owned qualifiers is refused, not sent empty',
    (() => {
      try {
        readParams({ query: 'state:closed is:pr' })
        return false
      } catch (error) {
        return error.message.includes('not only repo:/state:/is: qualifiers')
      }
    })())
  check('a bad repo is named, not silently dropped',
    (() => {
      try {
        readParams({ query: 'x', repo: 'not a repo' })
        return false
      } catch (error) {
        return error.message.includes('repo must look like owner/name')
      }
    })())
  check('issuesUrl carries the built query, per_page and order',
    (() => {
      const url = new URL(issuesUrl(readParams({ query: 'label:bug crash', limit: 3 })))
      return url.searchParams.get('q') === 'label:bug crash state:open is:issue' &&
        url.searchParams.get('per_page') === '3' && url.searchParams.get('order') === 'desc'
    })())
}

// --- the token never leaks -------------------------------------------------

{
  clearCache()
  delete process.env.Z1_GITHUB_TOKEN
  delete process.env.GITHUB_TOKEN
  const { ctx, requests } = broker(() => reply(HITS))
  await call(ctx, { query: 'cache key check' })
  check('no token is configured, so none is reported', tokenSource() === undefined)

  process.env.Z1_GITHUB_TOKEN = TOKEN
  const shared = await call(ctx, { query: 'cache key check' })
  check('the token is not part of the cache key (same query, one request)',
    requests.length === 1, `${requests.length} requests`)
  check('that cached answer echoes no token', !shared.includes(TOKEN), shared.split('\n')[0])

  const { ctx: tokenCtx, requests: tokenRequests } = broker(() => reply(HITS))
  const answer = await call(tokenCtx, { query: 'token header check' })
  check('the token is sent as a Bearer header only',
    tokenRequests[0].headers.authorization === `Bearer ${TOKEN}`, JSON.stringify(tokenRequests[0].headers))
  check('the token never appears in the answer', !answer.includes(TOKEN), answer.split('\n')[0])
  check('the token never reaches the URL or the query',
    !tokenRequests[0].url.includes(TOKEN) && !queryOf(tokenRequests[0]).includes(TOKEN), tokenRequests[0].url)
}

// --- 401 names the active variable ----------------------------------------

{
  clearCache()
  process.env.Z1_GITHUB_TOKEN = TOKEN
  delete process.env.GITHUB_TOKEN
  const { ctx } = broker(() => reply({ message: 'Bad credentials' }, 401, { 'content-type': 'application/json' }))
  const message = await errorOf(() => call(ctx, { query: '401 with z1 token' }))
  check('401 names Z1_GITHUB_TOKEN, the variable that was in effect',
    message.includes('GitHub rejected Z1_GITHUB_TOKEN (HTTP 401)'), message)
  check('401 does not also blame GITHUB_TOKEN', !message.includes('rejected GITHUB_TOKEN'), message)
  check('401 keeps the token value out of the message', !message.includes(TOKEN), message)
  check('401 says anonymous search still works', message.includes('anonymous search still works'), message)
}

{
  clearCache()
  delete process.env.Z1_GITHUB_TOKEN
  process.env.GITHUB_TOKEN = TOKEN
  const { ctx } = broker(() => reply({ message: 'Bad credentials' }, 401))
  const message = await errorOf(() => call(ctx, { query: '401 with plain token' }))
  check('401 names GITHUB_TOKEN when that is the one set',
    message.includes('GitHub rejected GITHUB_TOKEN (HTTP 401)') && !message.includes('Z1_GITHUB_TOKEN'), message)
  check('that message holds no token value either', !message.includes(TOKEN), message)
}

{
  clearCache()
  delete process.env.Z1_GITHUB_TOKEN
  delete process.env.GITHUB_TOKEN
  const { ctx } = broker(() => reply({ message: 'Bad credentials' }, 401))
  const message = await errorOf(() => call(ctx, { query: '401 anonymous' }))
  check('401 without a token says so', message.includes('GitHub answered HTTP 401 (no token was sent)'), message)
}

// --- 403 rate limit -------------------------------------------------------

{
  clearCache()
  delete process.env.Z1_GITHUB_TOKEN
  delete process.env.GITHUB_TOKEN
  const { ctx } = broker(() => reply({ message: 'API rate limit exceeded' }, 403, {
    'x-ratelimit-remaining': '0',
    'x-ratelimit-limit': '10',
    'x-ratelimit-reset': '1709337600',
  }))
  const message = await errorOf(() => call(ctx, { query: '403 anonymous' }))
  check('403 with zero remaining is the rate limit, with the reset clock',
    message.includes('GitHub rate limit reached · the search quota resets at 00:00:00 UTC'), message)
  check('the anonymous 403 offers the token as the way to 30/min',
    message.includes('10/min anonymous · set Z1_GITHUB_TOKEN for 30/min'), message)
  check('the 403 line says answers are cached', message.includes('answers are cached for 5 minutes'), message)
}

{
  clearCache()
  process.env.Z1_GITHUB_TOKEN = TOKEN
  const { ctx } = broker(() => reply({ message: 'API rate limit exceeded' }, 403, {
    'x-ratelimit-remaining': '0',
    'x-ratelimit-limit': '30',
    'x-ratelimit-reset': '1709337600',
  }))
  const message = await errorOf(() => call(ctx, { query: '403 with token' }))
  check('a token user gets the 30/min wording, not the anonymous hint',
    message.includes('30/min with a GitHub token') && !message.includes('anonymous'), message)
  check('the token value stays out of the 403 too', !message.includes(TOKEN), message)
}

{
  clearCache()
  delete process.env.Z1_GITHUB_TOKEN
  const { ctx } = broker(() => reply({ message: 'Forbidden by policy' }, 403, {
    'x-ratelimit-remaining': '7',
    'x-ratelimit-limit': '10',
  }))
  const message = await errorOf(() => call(ctx, { query: '403 other' }))
  check('a 403 that is not the rate limit is reported as a refusal',
    message.includes('GitHub refused the request (HTTP 403 · Forbidden by policy)') && !message.includes('rate limit reached'),
    message)
}

// --- normalisation --------------------------------------------------------

{
  const kept = normaliseItems(HITS.items)
  check('normaliseItems keeps the fields the renderer needs',
    kept.length === 2 && kept[0].repo === 'rust-lang/rust' && kept[0].updated === '2024-03-02' &&
      kept[0].number === 12345 && kept[1].state === 'closed', JSON.stringify(kept[0]))
  check('an unknown state is reported as open, never as undefined',
    normaliseItems([{ ...HITS.items[0], state: 'draft' }])[0].state === 'open')
  check('a hit without a repo URL has no repo field',
    normaliseItems([{ ...HITS.items[0], repository_url: undefined }])[0].repo === undefined)
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
