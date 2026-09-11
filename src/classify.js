// Provider-agnostic prompt + response handling. Providers only turn
// {system, prompt, schema} into a JSON object; everything tweet-specific lives here.

const MAX_TWEET_CHARS = 500;

function clip(text) {
  return text.length > MAX_TWEET_CHARS ? `${text.slice(0, MAX_TWEET_CHARS)}…` : text;
}

const MEDIA_NAMES = { photo: 'photo', video: 'video', animated_gif: 'GIF' };

// "[attached: 2 photos, 1 video]" — the model can't see media, but must know it's there.
function attachments(media) {
  if (!media?.length) return '';
  const counts = {};
  for (const type of media) counts[MEDIA_NAMES[type] ?? 'file'] = (counts[MEDIA_NAMES[type] ?? 'file'] ?? 0) + 1;
  const parts = Object.entries(counts).map(([name, n]) => `${n} ${name}${n > 1 ? 's' : ''}`);
  return ` [attached: ${parts.join(', ')}]`;
}

function formatTweet(tweet, n) {
  let line = `[${n}] @${tweet.author || 'unknown'}: ${clip(tweet.text)}${attachments(tweet.media)}`;
  if (tweet.quoted) {
    line += `\n    (quoting @${tweet.quoted.author || 'unknown'}: ${clip(tweet.quoted.text)}${attachments(tweet.quoted.media)})`;
  }
  return line;
}

export function buildRequest(tweets, policy) {
  const system = `You filter posts in a user's X (Twitter) feed according to the user's rules.

<rules>
${policy.trim()}
</rules>

For each numbered post, answer "filter" only if it clearly matches something the rules say to hide; otherwise answer "keep". When unsure, keep. Give a reason of at most six words.

Posts marked [attached: ...] include images or videos you cannot see. Don't treat a post as vague or unsupported just because its substance may be in an attachment.`;

  // Posts are numbered rather than keyed by tweet id: small models garble 19-digit ids.
  const prompt = tweets.map((tweet, i) => formatTweet(tweet, i + 1)).join('\n\n');

  const schema = {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        minItems: tweets.length,
        maxItems: tweets.length,
        items: {
          type: 'object',
          // reason precedes verdict so the model commits to a rationale first
          properties: {
            n: { type: 'integer' },
            reason: { type: 'string' },
            verdict: { type: 'string', enum: ['keep', 'filter'] },
          },
          required: ['n', 'reason', 'verdict'],
          additionalProperties: false,
        },
      },
    },
    required: ['results'],
    additionalProperties: false, // required by OpenAI strict mode
  };

  return { system, prompt, schema };
}

export function parseResponse(response, tweets) {
  const results = Array.isArray(response?.results) ? response.results : [];
  const byN = new Map(results.map((r) => [r?.n, r]));
  return tweets.map((tweet, i) => {
    const r = byN.get(i + 1) ?? results[i];
    return {
      id: tweet.id,
      verdict: r?.verdict === 'filter' ? 'filter' : 'keep',
      reason: String(r?.reason ?? '').slice(0, 80),
    };
  });
}
