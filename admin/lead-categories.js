/**
 * Lead category (vertical) normalization for imports and agent filtering.
 * Admin CSV column: Category, Vertical, Industry, Type, or Campaign.
 */
(function (global) {
  var RULES = [
    {
      label: 'Restaurant',
      re:
        /restaurant|restaurants|dining|food service|bistro|grill|grille|taco|tacos|pizza|pizzeria|bar\s*&\s*grill|eatery|bakery|ramen|mexican|cantina|taqueria|diner|kitchen|sushi|bbq|barbecue|steakhouse|seafood|burger|wings|pho|noodle|inn\b|bistro/i,
    },
    { label: 'Coffee Shop', re: /coffee\s*shop|coffee\s*house|coffeehouse|coffee\s*bar|espresso|roaster|tea\s*shop|\bcoffee\b/i },
    { label: 'Construction', re: /construction|contractor|roofing|plumbing|hvac|builder|remodel|electric|landscap|paving|concrete/i },
    { label: 'Golf', re: /golf|country club/i },
    { label: 'Detailing', re: /detail|car wash|auto wash/i },
    { label: 'Retail', re: /retail|boutique/i },
    { label: 'Medical', re: /medical|dental|clinic|health/i },
    { label: 'Automotive', re: /automotive|auto repair|mechanic|dealership/i },
  ];

  function normalizeLeadCategory(raw) {
    var s = String(raw || '').trim();
    if (!s) return 'General';
    for (var i = 0; i < RULES.length; i++) {
      if (RULES[i].re.test(s)) return RULES[i].label;
    }
    if (s.length <= 48) {
      return s.replace(/\w\S*/g, function (w) {
        return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
      });
    }
    return 'General';
  }

  function inferLeadCategory(rawCategory, business, contactName) {
    var raw = String(rawCategory || '').trim();
    if (raw) {
      var fromCol = normalizeLeadCategory(raw);
      if (fromCol !== 'General') return fromCol;
    }
    var blob = [business, contactName].filter(Boolean).join(' ').trim();
    if (blob) {
      var fromBiz = normalizeLeadCategory(blob);
      if (fromBiz !== 'General') return fromBiz;
    }
    return raw ? normalizeLeadCategory(raw) : 'General';
  }

  function categoryTagClass(vertical) {
    var c = normalizeLeadCategory(vertical);
    var slug = c
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    return 'tag-cat-' + (slug || 'general');
  }

  global.NorthstarLeadCategories = {
    normalize: normalizeLeadCategory,
    infer: inferLeadCategory,
    tagClass: categoryTagClass,
    rules: RULES.map(function (r) {
      return r.label;
    }),
  };
})(typeof window !== 'undefined' ? window : this);
