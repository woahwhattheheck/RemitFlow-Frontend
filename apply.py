import hashlib
from pathlib import Path
import subprocess

p = Path('src/pages/Transfers.jsx')
s = p.read_text()
assert subprocess.check_output(['git', 'hash-object', str(p)], text=True).strip() == '741a94ffe667d7085dd3610b1a920da63db5e6b7'
s = s.replace("import { useCallback, useEffect, useMemo, useState } from 'react';", "import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';")
s = s.replace("import { Link, useSearchParams } from 'react-router-dom';", "import { Link, useLocation, useNavigationType, useSearchParams } from 'react-router-dom';")
s = s.replace("import { useDebouncedValue } from '../hooks/useDebouncedValue.js';\n", '')
s = s.replace('  const [searchParams, setSearchParams] = useSearchParams();', '  const [searchParams, setSearchParams] = useSearchParams();\n  const location = useLocation();\n  const navigationType = useNavigationType();')
start = s.index('  // Draft input updates immediately;')
end = s.index('  const queryFilters = useMemo(', start)
s = s[:start] + '''  // Only a user edit may schedule a URL write. Navigation is authoritative.
  const [searchDraft, setSearchDraft] = useState(urlSearch);
  const pendingSearch = useRef(null);

  useLayoutEffect(() => {
    const pending = pendingSearch.current;
    // POP also retires a draft when history changes only status/range.
    // Local filter controls use PUSH and may preserve an unfinished edit.
    if (navigationType === 'POP' || !pending || pending.baseSearch !== urlSearch) {
      pendingSearch.current = null;
      setSearchDraft(urlSearch);
    }
  }, [urlSearch, location.key, navigationType]);

  useEffect(() => {
    const pending = pendingSearch.current;
    if (!pending || pending.value !== searchDraft || pending.baseSearch !== urlSearch) {
      return;
    }
    const timer = setTimeout(() => {
      if (pendingSearch.current !== pending) return;
      pendingSearch.current = null;
      setSearchParams((prev) => {
        if ((prev.get('search') || '') !== pending.baseSearch) return prev;
        const next = new URLSearchParams(prev);
        if (pending.value) next.set('search', pending.value);
        else next.delete('search');
        return next;
      }, { replace: true });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchDraft, urlSearch, setSearchParams]);

''' + s[end:]
s = s.replace('debouncedSearch', 'urlSearch')
old = '''  const handleSearchChange = useCallback((e) => {
    setSearchDraft(e.target.value);
  }, []);'''
new = '''  const handleSearchChange = useCallback((e) => {
    const value = e.target.value;
    pendingSearch.current = value === urlSearch ? null : { value, baseSearch: urlSearch };
    setSearchDraft(value);
  }, [urlSearch]);'''
assert old in s
s = s.replace(old, new)
s = s.replace("  const handleClearFilters = useCallback(() => {\n    setSearchDraft('');", "  const handleClearFilters = useCallback(() => {\n    pendingSearch.current = null;\n    setSearchDraft('');")
p.write_text(s)
print('patched', hashlib.sha256(p.read_bytes()).hexdigest())
