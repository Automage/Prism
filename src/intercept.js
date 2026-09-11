// Runs in the page's MAIN world at document_start. Watches X's own GraphQL
// responses so tweets can be classified before they're scrolled into view,
// then hands them to the isolated-world content script via postMessage.
(() => {
  const SOURCE = 'prism:tweets';
  const GRAPHQL = /\/i\/api\/graphql\/[^/]+\/(\w+)/;
  const MAX_CHARS = 1200;
  // Feeds you scroll through. Tweets from these are classified ahead of time; tweets from
  // any other response (search, bookmarks, your own new post, ...) are only used as data
  // and get classified if and when they reach the screen.
  const PREFETCH_OPERATIONS = new Set([
    'HomeTimeline',
    'HomeLatestTimeline',
    'ListLatestTweetsTimeline',
    'UserTweets',
    'UserTweetsAndReplies',
    'TweetDetail',
  ]);

  function unwrap(result) {
    if (!result) return null;
    if (result.__typename === 'TweetWithVisibilityResults') return result.tweet ?? null;
    if (result.rest_id && result.legacy) return result;
    return null;
  }

  function screenName(tweet) {
    const user = tweet.core?.user_results?.result;
    return user?.core?.screen_name ?? user?.legacy?.screen_name ?? '';
  }

  function decode(text) {
    return text
      .replace(/https:\/\/t\.co\/\w+/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim()
      .slice(0, MAX_CHARS);
  }

  function textOf(tweet) {
    const body = decode(tweet.note_tweet?.note_tweet_results?.result?.text ?? tweet.legacy?.full_text ?? '');
    if (body) return body;
    // X Articles carry a bare link as full_text; the title/preview is the substance.
    const article = tweet.article?.article_results?.result;
    return article ? decode([article.title, article.preview_text].filter(Boolean).join('\n')) : '';
  }

  // 'photo' | 'video' | 'animated_gif' per attachment; the model can't see them but should know they exist.
  function mediaOf(tweet) {
    return (tweet.legacy?.extended_entities?.media ?? tweet.legacy?.entities?.media ?? []).map((m) => m.type);
  }

  function toTweet(raw) {
    // A retweet renders as the original tweet, and the DOM links to the original's id.
    const original = unwrap(raw.legacy?.retweeted_status_result?.result);
    if (original) return toTweet(original);

    const tweet = { id: raw.rest_id, author: screenName(raw), text: textOf(raw), media: mediaOf(raw) };
    const quoted = unwrap(raw.quoted_status_result?.result);
    if (quoted) tweet.quoted = { author: screenName(quoted), text: textOf(quoted), media: mediaOf(quoted) };
    return tweet;
  }

  // Walk the whole response instead of hardcoding timeline paths, so this works for
  // home, lists, search, profiles and threads alike. Quoted tweets aren't recursed
  // into; they travel with the tweet that quotes them.
  function collect(node, out) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) collect(child, out);
      return;
    }
    // Timeline items for ads carry promotedMetadata next to the tweet.
    if (node.promotedMetadata && node.tweet_results?.result) {
      const ad = unwrap(node.tweet_results.result);
      if (ad) {
        out.push({ ...toTweet(ad), promoted: true });
        return;
      }
    }
    const tweet = node.__typename === 'Tweet' || node.__typename === 'TweetWithVisibilityResults' ? unwrap(node) : null;
    if (tweet) {
      out.push(toTweet(tweet));
      return;
    }
    for (const key in node) collect(node[key], out);
  }

  function publish(json, operation) {
    const tweets = [];
    try {
      collect(json, tweets);
    } catch {
      return;
    }
    if (!tweets.length) return;
    window.postMessage({ source: SOURCE, tweets, prefetch: PREFETCH_OPERATIONS.has(operation) }, location.origin);
  }

  // X loads timelines over XHR. Only send() is hooked, and the URL is read from
  // responseURL, because other extensions may wrap open().
  const { send } = XMLHttpRequest.prototype;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => {
      const operation = this.responseURL.match(GRAPHQL)?.[1];
      if (!operation) return;
      try {
        const type = this.responseType;
        if (type === 'json') publish(this.response, operation);
        else if (type === '' || type === 'text') publish(JSON.parse(this.responseText), operation);
      } catch {}
    });
    return send.apply(this, args);
  };

  const originalFetch = window.fetch;
  window.fetch = async function (input, init) {
    const response = await originalFetch.call(this, input, init);
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    const operation = url.match(GRAPHQL)?.[1];
    if (operation) response.clone().json().then((json) => publish(json, operation), () => {});
    return response;
  };
})();
