// tools/r23/site-signals/stack-table.js: the technology-detection table, as DATA (R23 T6).
// Each entry: { name, category, rules: [...] }; a rule is one way a technology shows itself on the wire or in the page:
//   H(header, re)   a response header whose value matches (group 1, when the pattern has one, is the version)
//   C(re)           a cookie NAME in Set-Cookie
//   G(re)           the content of <meta name="generator">
//   A(re)           the URL of a <script src> or <link href>
//   X(text, re?)    the page text contains `text` (re, when given, reads a version from the 80 characters that follow it)
// Every pattern is ours, written from each product's public documentation and from the markup such products are known to emit (WordPress's wp-content and wp-includes
// paths, Next.js's /_next/static/, Shopify's cdn.shopify.com, the X-Powered-By and Server tokens, and so on). No pattern list was copied from Wappalyzer (its fingerprints
// are GPL-3 / proprietary), webtech, WhatWeb or any other detector. A match is a hint that a marker is present, not proof of what runs behind it.
'use strict';

const H = (name, re) => ({ in: 'header', name, re });
const C = (re) => ({ in: 'cookie', re });
const G = (re) => ({ in: 'generator', re });
const A = (re) => ({ in: 'asset', re });
const X = (text, re) => ({ in: 'html', text, re });
const ANY = /./;                                  // header present, any value

const TABLE = [
  // ---- web servers and runtimes
  { name: 'nginx', category: 'web-server', rules: [H('server', /^nginx(?:\/([\w.\-]+))?/i)] },
  { name: 'Apache HTTP Server', category: 'web-server', rules: [H('server', /^Apache(?:\/([\d.]+))?(?!-Coyote)/i)] },
  { name: 'Apache Tomcat', category: 'web-server', rules: [H('server', /^Apache-Coyote(?:\/([\d.]+))?|^Tomcat/i)] },
  { name: 'Microsoft IIS', category: 'web-server', rules: [H('server', /^Microsoft-IIS(?:\/([\d.]+))?/i)] },
  { name: 'LiteSpeed', category: 'web-server', rules: [H('server', /^LiteSpeed/i)] },
  { name: 'Caddy', category: 'web-server', rules: [H('server', /^Caddy/i)] },
  { name: 'OpenResty', category: 'web-server', rules: [H('server', /^openresty(?:\/([\d.]+))?/i)] },
  { name: 'Envoy', category: 'web-server', rules: [H('server', /^envoy/i)] },
  { name: 'Kestrel', category: 'web-server', rules: [H('server', /^Kestrel/i)] },
  { name: 'Jetty', category: 'web-server', rules: [H('server', /^Jetty(?:\(([\w.\-]+)\))?/i)] },
  { name: 'gunicorn', category: 'web-server', rules: [H('server', /^gunicorn(?:\/([\d.]+))?/i)] },
  { name: 'Granian', category: 'web-server', rules: [H('server', /^granian/i)] },
  { name: 'uvicorn', category: 'web-server', rules: [H('server', /^uvicorn/i)] },
  { name: 'Phusion Passenger', category: 'web-server', rules: [H('x-powered-by', /Phusion Passenger(?:\s+([\d.]+))?/i)] },
  // ---- hosting and CDN
  { name: 'Cloudflare', category: 'cdn', rules: [H('server', /^cloudflare/i), H('cf-ray', ANY), H('cf-cache-status', ANY)] },
  { name: 'Fastly', category: 'cdn', rules: [H('x-served-by', /cache-/i), H('x-fastly-request-id', ANY)] },
  { name: 'Akamai', category: 'cdn', rules: [H('server', /^Akamai(?:GHost|NetStorage)/i), H('x-akamai-transformed', ANY), H('x-akamai-request-id', ANY)] },
  { name: 'Amazon CloudFront', category: 'cdn', rules: [H('x-amz-cf-id', ANY), H('via', /CloudFront/i)] },
  { name: 'Varnish', category: 'cdn', rules: [H('x-varnish', ANY), H('via', /varnish/i)] },
  { name: 'Azure Front Door', category: 'cdn', rules: [H('x-azure-ref', ANY)] },
  { name: 'Netlify', category: 'hosting', rules: [H('server', /^Netlify/i), H('x-nf-request-id', ANY)] },
  { name: 'Vercel', category: 'hosting', rules: [H('server', /^Vercel/i), H('x-vercel-id', ANY)] },
  { name: 'GitHub', category: 'hosting', rules: [H('server', /^GitHub\.com$/i), H('x-github-request-id', ANY)] },
  { name: 'Google Frontend', category: 'hosting', rules: [H('server', /^Google Frontend/i)] },
  { name: 'Google Web Server', category: 'hosting', rules: [H('server', /^gws$/i)] },
  { name: 'Amazon S3', category: 'hosting', rules: [H('server', /^AmazonS3/i)] },
  { name: 'Heroku', category: 'hosting', rules: [H('via', /vegur/i)] },
  // ---- languages and frameworks
  { name: 'PHP', category: 'language', rules: [H('x-powered-by', /^PHP(?:\/([\d.]+))?/i), C(/^PHPSESSID$/)] },
  { name: 'ASP.NET', category: 'framework', rules: [H('x-powered-by', /ASP\.NET/i), H('x-aspnet-version', /^([\d.]+)/), C(/^ASP\.NET_SessionId$/)] },
  { name: 'Express', category: 'framework', rules: [H('x-powered-by', /^Express/i), C(/^connect\.sid$/)] },
  { name: 'Next.js', category: 'framework', rules: [H('x-powered-by', /^Next\.js(?:\s+([\d.]+))?/i), A(/\/_next\/static\//), X('__NEXT_DATA__')] },
  { name: 'Nuxt', category: 'framework', rules: [A(/\/_nuxt\//), X('id="__nuxt"')] },
  { name: 'SvelteKit', category: 'framework', rules: [A(/\/_app\/immutable\//)] },
  { name: 'Laravel', category: 'framework', rules: [C(/^laravel_session$/)] },
  { name: 'Java servlet container', category: 'language', rules: [C(/^JSESSIONID$/)] },
  // ---- content management and site generators
  { name: 'WordPress', category: 'cms', rules: [G(/^WordPress(?:\s+([\d.]+))?/i), A(/\/wp-(?:content|includes)\//i), H('link', /api\.w\.org/i), H('x-pingback', ANY)] },
  { name: 'Drupal', category: 'cms', rules: [G(/^Drupal(?:\s+([\d.]+))?/i), H('x-generator', /Drupal(?:\s+([\d.]+))?/i), H('x-drupal-cache', ANY), A(/\/sites\/(?:default|all)\/(?:files|modules|themes)\//i)] },
  { name: 'Joomla', category: 'cms', rules: [G(/^Joomla/i)] },
  { name: 'Ghost', category: 'cms', rules: [G(/^Ghost(?:\s+([\d.]+))?/i)] },
  { name: 'TYPO3', category: 'cms', rules: [G(/^TYPO3/i)] },
  { name: 'MediaWiki', category: 'cms', rules: [G(/^MediaWiki(?:\s+([\d.]+))?/i)] },
  { name: 'Shopify', category: 'ecommerce', rules: [A(/cdn\.shopify\.com/i), H('x-shopify-stage', ANY)] },
  { name: 'PrestaShop', category: 'ecommerce', rules: [G(/^PrestaShop/i)] },
  { name: 'Squarespace', category: 'site-builder', rules: [G(/^Squarespace/i), A(/static\d*\.squarespace\.com|images\.squarespace-cdn\.com/i)] },
  { name: 'Wix', category: 'site-builder', rules: [G(/^Wix\.com/i), A(/static\.parastorage\.com|static\.wixstatic\.com/i), H('x-wix-request-id', ANY)] },
  { name: 'Webflow', category: 'site-builder', rules: [G(/^Webflow/i), X('data-wf-site=')] },
  { name: 'Hugo', category: 'static-site-generator', rules: [G(/^Hugo(?:\s+([\d.]+))?/i)] },
  { name: 'Jekyll', category: 'static-site-generator', rules: [G(/^Jekyll(?:\s+v?([\d.]+))?/i)] },
  { name: 'Gatsby', category: 'static-site-generator', rules: [G(/^Gatsby(?:\s+([\d.]+))?/i)] },
  { name: 'Docusaurus', category: 'static-site-generator', rules: [G(/^Docusaurus(?:\s+v?([\d.]+))?/i)] },
  { name: 'MkDocs', category: 'static-site-generator', rules: [G(/^mkdocs(?:-([\w.\-]+))?/i)] },
  { name: 'Sphinx', category: 'static-site-generator', rules: [A(/(?:^|\/)_static\/(?:documentation_options|sphinx_highlight|doctools)\.js/i)] },
  { name: 'Astro', category: 'static-site-generator', rules: [G(/^Astro(?:\s+v?([\d.]+))?/i), X('astro-island')] },
  { name: 'Hexo', category: 'static-site-generator', rules: [G(/^Hexo/i)] },
  { name: 'Eleventy', category: 'static-site-generator', rules: [G(/^Eleventy(?:\s+v?([\d.]+))?/i)] },
  // ---- front-end libraries
  { name: 'React', category: 'js-library', rules: [X('data-reactroot'), A(/\/react(?:-dom)?(?:\.production)?(?:\.min)?\.js/i)] },
  { name: 'Vue.js', category: 'js-library', rules: [A(/\/vue(?:\.runtime)?(?:\.global)?(?:\.prod)?(?:\.min)?\.js|\/vue@/i)] },
  { name: 'Angular', category: 'js-library', rules: [X('ng-version="', /ng-version="([\w.\-]+)"/)] },
  { name: 'jQuery', category: 'js-library', rules: [A(/jquery(?:[-.](\d+\.\d+(?:\.\d+)?))?(?:\.slim)?(?:\.min)?\.js/i), A(/jquery@(\d+\.\d+(?:\.\d+)?)/i)] },
  { name: 'Bootstrap', category: 'js-library', rules: [A(/bootstrap(?:[-.](\d+\.\d+(?:\.\d+)?))?(?:\.bundle)?(?:\.min)?\.(?:js|css)/i), A(/bootstrap@(\d+\.\d+(?:\.\d+)?)/i)] },
  { name: 'Tailwind CSS', category: 'js-library', rules: [A(/tailwindcss|cdn\.tailwindcss\.com/i)] },
  { name: 'Alpine.js', category: 'js-library', rules: [A(/\/alpinejs[@/]|\/alpine(?:\.min)?\.js/i)] },
  { name: 'htmx', category: 'js-library', rules: [A(/htmx(?:\.min)?\.js|\/htmx\.org/i)] },
  { name: 'Font Awesome', category: 'font', rules: [A(/font-?awesome/i)] },
  { name: 'Google Fonts', category: 'font', rules: [A(/fonts\.googleapis\.com|fonts\.gstatic\.com/i)] },
  // ---- analytics, tags and embedded services
  { name: 'Google Tag Manager', category: 'analytics', rules: [A(/googletagmanager\.com\/gtm\.js/i)] },
  { name: 'Google Analytics', category: 'analytics', rules: [A(/googletagmanager\.com\/gtag\/js|google-analytics\.com\/(?:analytics|ga)\.js/i)] },
  { name: 'Cloudflare Web Analytics', category: 'analytics', rules: [A(/static\.cloudflareinsights\.com\/beacon/i)] },
  { name: 'Plausible', category: 'analytics', rules: [A(/plausible\.io\/js\//i)] },
  { name: 'Matomo', category: 'analytics', rules: [A(/matomo\.js|piwik\.js/i)] },
  { name: 'Hotjar', category: 'analytics', rules: [A(/static\.hotjar\.com/i)] },
  { name: 'Segment', category: 'analytics', rules: [A(/cdn\.segment\.com/i)] },
  { name: 'Meta Pixel', category: 'analytics', rules: [A(/connect\.facebook\.net\/[\w_]+\/fbevents\.js/i)] },
  { name: 'HubSpot', category: 'marketing', rules: [A(/js\.hs-scripts\.com|js\.hsforms\.net/i)] },
  { name: 'Sentry', category: 'monitoring', rules: [A(/browser\.sentry-cdn\.com|js\.sentry-cdn\.com/i)] },
  { name: 'reCAPTCHA', category: 'captcha', rules: [A(/google\.com\/recaptcha|gstatic\.com\/recaptcha/i)] },
  { name: 'hCaptcha', category: 'captcha', rules: [A(/hcaptcha\.com/i)] },
  { name: 'Cloudflare Turnstile', category: 'captcha', rules: [A(/challenges\.cloudflare\.com\/turnstile/i)] },
  { name: 'Stripe.js', category: 'payments', rules: [A(/js\.stripe\.com/i)] },
];

module.exports = { TABLE };
