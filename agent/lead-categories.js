/**
 * Lead category (vertical) normalization for imports and agent filtering.
 * Admin CSV column: Category, Vertical, Industry, Type, or Campaign.
 */
(function (global) {
  var RULES = [
    { label: 'Restaurant', re: /restaurant|dining|food service|bistro|grill|taco|pizza|bar\s*&\s*grill|eatery|bakery/i },
    { label: 'Coffee Shop', re: /coffee|cafe|café|espresso|roaster|tea shop/i },
    { label: 'Construction', re: /construction|contractor|roofing|plumbing|hvac|builder|remodel|electric|landscap|paving|concrete/i },
    { label: 'Golf', re: /golf|country club/i },
    { label: 'Detailing', re: /detail|car wash|auto wash/i },
    { label: 'Retail', re: /retail|store|shop|boutique/i },
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
    tagClass: categoryTagClass,
    rules: RULES.map(function (r) {
      return r.label;
    }),
  };
})(typeof window !== 'undefined' ? window : this);
