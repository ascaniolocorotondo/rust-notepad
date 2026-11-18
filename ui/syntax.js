// Colorazione della sintassi, semplice e senza librerie esterne.
// Riconosce commenti, stringhe, numeri, parole chiave, tipi e chiamate di funzione.

const Syntax = (() => {
  const KW = {
    rust: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
    python: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield',
    javascript: 'async await break case catch class const continue debugger default delete do else export extends false finally for function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while yield',
    typescript: 'abstract any as async await boolean break case catch class const continue declare default do else enum export extends false finally for from function if implements import in interface keyof let namespace never new null number of private protected public readonly return static string super switch this throw true try type typeof undefined unknown var void while',
    c: 'auto break case char const continue default do double else enum extern float for goto if int long register return short signed sizeof static struct switch typedef union unsigned void volatile while include define',
    cpp: 'auto bool break case catch char class const constexpr continue default delete do double else enum explicit false float for friend if include inline int long namespace new nullptr private protected public return short sizeof static struct switch template this throw true try typedef typename using virtual void while',
    java: 'abstract boolean break byte case catch char class continue default do double else enum extends false final finally float for if implements import instanceof int interface long new null package private protected public return short static super switch this throw throws true try void while',
    go: 'break case chan const continue default defer else fallthrough false for func go goto if import interface map nil package range return select struct switch true type var',
    swift: 'as break case catch class continue default defer do else enum extension false for func guard if import in init let nil private protocol public return self static struct switch throw throws true try var where while',
    bash: 'if then else elif fi for while do done case esac function in return export local echo exit',
    sql: 'select from where insert into values update set delete create table drop alter join left right inner outer on group by order having limit and or not null as distinct primary key',
    css: 'important',
    json: 'true false null',
    html: '',
    testo: '',
  };
  KW.php = KW.javascript;

  const LINE_COMMENT = {
    python: '#', bash: '#', sql: '--',
    rust: '//', javascript: '//', typescript: '//', c: '//', cpp: '//', java: '//', go: '//', swift: '//', php: '//',
  };

  const sets = {};
  const kwSet = (lang) => (sets[lang] ??= new Set((KW[lang] || '').split(' ').filter(Boolean)));

  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const span = (cls, s) => `<span class="tok-${cls}">${esc(s)}</span>`;

  function highlightHtml(code) {
    const re = /(<!--[\s\S]*?(?:-->|$))|(<\/?[\w-]+)|("[^"]*"|'[^']*')|(\/?>)/g;
    let out = '', last = 0, m;
    while ((m = re.exec(code))) {
      out += esc(code.slice(last, m.index));
      if (m[1]) out += span('com', m[1]);
      else if (m[2]) out += span('tag', m[2]);
      else if (m[3]) out += span('str', m[3]);
      else out += span('tag', m[4]);
      last = re.lastIndex;
    }
    return out + esc(code.slice(last));
  }

  function highlight(code, lang) {
    if (!lang || lang === 'testo') return esc(code);
    if (lang === 'html' || lang === 'xml') return highlightHtml(code);

    const lc = LINE_COMMENT[lang];
    const parts = [];
    if (lc) parts.push(lc.replace(/[/]/g, '\\/') + '[^\\n]*');
    if (lang !== 'python' && lang !== 'bash' && lang !== 'sql') parts.push('\\/\\*[\\s\\S]*?(?:\\*\\/|$)');
    if (lang === 'python') parts.push('"""[\\s\\S]*?(?:"""|$)', "'''[\\s\\S]*?(?:'''|$)");
    const commentSrc = parts.join('|');

    // Rust usa ' per i lifetime: niente stringhe con apice singolo.
    const strSrc = lang === 'rust'
      ? '"(?:\\\\.|[^"\\\\])*"?'
      : '"(?:\\\\.|[^"\\\\\\n])*"?|\'(?:\\\\.|[^\'\\\\\\n])*\'?|`(?:\\\\.|[^`\\\\])*`?';

    const re = new RegExp(
      `(${commentSrc || '(?!)'})|(${strSrc})|(\\b\\d[\\d_]*(?:\\.\\d+)?(?:e[+-]?\\d+)?\\b|\\b0x[\\da-f]+\\b)|([A-Za-z_][\\w]*)(?=\\s*\\()|([A-Za-z_][\\w]*)`,
      'gi'
    );

    const kws = kwSet(lang);
    const caseless = lang === 'sql';
    let out = '', last = 0, m;
    while ((m = re.exec(code))) {
      out += esc(code.slice(last, m.index));
      const [tok, com, str, num, fn, word] = m;
      if (com) out += span('com', com);
      else if (str) out += span('str', str);
      else if (num) out += span('num', num);
      else {
        const w = fn || word;
        if (kws.has(caseless ? w.toLowerCase() : w)) out += span('kw', w);
        else if (fn) out += span('fn', w);
        else if (/^[A-Z][a-z]\w*$/.test(w)) out += span('type', w);
        else out += esc(w);
      }
      last = m.index + tok.length;
      if (tok.length === 0) re.lastIndex++;
    }
    return out + esc(code.slice(last));
  }

  const LANGUAGES = [
    ['testo', 'Testo'], ['python', 'Python'], ['javascript', 'JavaScript'], ['typescript', 'TypeScript'],
    ['rust', 'Rust'], ['html', 'HTML'], ['css', 'CSS'], ['c', 'C'], ['cpp', 'C++'], ['java', 'Java'],
    ['go', 'Go'], ['swift', 'Swift'], ['php', 'PHP'], ['sql', 'SQL'], ['bash', 'Bash'], ['json', 'JSON'],
  ];

  const ALIASES = { py: 'python', js: 'javascript', ts: 'typescript', rs: 'rust', sh: 'bash', zsh: 'bash', 'c++': 'cpp', text: 'testo', txt: 'testo' };
  const normalize = (l) => {
    const x = (l || '').trim().toLowerCase();
    const v = ALIASES[x] || x;
    return LANGUAGES.some(([k]) => k === v) ? v : 'testo';
  };

  return { highlight, LANGUAGES, normalize };
})();
