'use strict';

// Общие функции очистки LaTeX для build.js и полного каталога.
// Держим их отдельно, чтобы каталог и обычные варианты использовали
// одинаковую обработку текста.

const INVISIBLE_CHARS_RE = /[\u00AD\u200B-\u200F\u2060\uFEFF]/g;

const GREEK_TO_LATEX = {
  'α': '\\alpha', 'β': '\\beta', 'γ': '\\gamma', 'δ': '\\delta',
  'ε': '\\varepsilon', 'ζ': '\\zeta', 'η': '\\eta', 'θ': '\\theta',
  'ι': '\\iota', 'κ': '\\kappa', 'λ': '\\lambda', 'μ': '\\mu',
  'ν': '\\nu', 'ξ': '\\xi', 'π': '\\pi', 'ρ': '\\rho',
  'ς': '\\varsigma', 'σ': '\\sigma', 'τ': '\\tau', 'υ': '\\upsilon',
  'φ': '\\varphi', 'χ': '\\chi', 'ψ': '\\psi', 'ω': '\\omega',
  'Γ': '\\Gamma', 'Δ': '\\Delta', 'Θ': '\\Theta', 'Λ': '\\Lambda',
  'Ξ': '\\Xi', 'Π': '\\Pi', 'Σ': '\\Sigma', 'Υ': '\\Upsilon',
  'Φ': '\\Phi', 'Ψ': '\\Psi', 'Ω': '\\Omega',
  'µ': '\\mu'
};

function stripInvisibleChars(value) {
  return String(value == null ? '' : value)
    .normalize('NFC')
    .replace(/[\u0300-\u036F]/g, '')
    .replace(INVISIBLE_CHARS_RE, '')
    .replace(/[\u2028\u2029]/g, ' ')
    .replace(/\u00A0/g, ' ');
}

function fixKnownLatexTypos(value) {
  return value
    .replace(/(^|\n)[ \t]*\\newline\{\}(?:[ \t]*\\newline\{\})?[ \t]*(?=\n|$)/g, '$1')
    .replace(/\\le\s+ft(?![A-Za-z])/g, '')
    .replace(/\\equi\s*v(?![A-Za-z])/g, '\\equiv')
    .replace(/\\phantom\s*\^\\circC(?![A-Za-z])/g, '\\phantom{^\\circ\\text{C}}')
    .replace(/\\circC(?![A-Za-z])/g, '\\circ\\text{C}')
    .replace(/\\circR(?![A-Za-z])/g, '\\circ\\text{R}')
    .replace(/\\mathcalE(?![A-Za-z])/g, '\\mathcal{E}')
    .replace(/\\cdor(?![A-Za-z])/g, '\\cdot')
    .replace(/\\overrightarrow([A-Za-z0-9])(?![A-Za-z])/g, '\\overrightarrow{$1}')
    .replace(/_\\sum(?![A-Za-z])/g, '_{\\Sigma}')
    .replace(/\\mx(?![A-Za-z])/g, '_{\\max}')
    .replace(/\\ctg(?![A-Za-z])/g, '\\cot')
    .replace(/\\toX(?![A-Za-z])/g, '\\to X')
    .replace(/\\aplha(?![A-Za-z])/g, '\\alpha')
    .replace(/\\Dela(?![A-Za-z])/g, '\\Delta')
    .replace(/\\epslon(?![A-Za-z])/g, '\\varepsilon')
    .replace(/\\beginmatrix(?![A-Za-z])/g, '\\begin{matrix}')
    .replace(/\\endmatrix(?![A-Za-z])/g, '\\end{matrix}')
    .replace(/\\beginarray\s*\{([^{}]+)\}/g, '\\begin{array}{$1}')
    .replace(/\\beginarray([lcrp|]+)(?![A-Za-z])/g, '\\begin{array}{$1}')
    .replace(/\\endarray(?![A-Za-z])/g, '\\end{array}')
    .replace(/\\Rightarrowa(?![A-Za-z])/g, '\\Rightarrow a')
    .replace(/\\RightarrowF(?![A-Za-z])/g, '\\Rightarrow F')
    .replace(/\\ri(?![A-Za-z])/g, '\\pi')
    .replace(/_\\max(?![A-Za-z])/g, '_{\\max}')
    .replace(/_\\min(?![A-Za-z])/g, '_{\\min}')
    .replace(/\^\\max(?![A-Za-z])/g, '^{\\max}')
    .replace(/\^\\min(?![A-Za-z])/g, '^{\\min}')
    .replace(/\\(vec|bar|hat|tilde|dot|ddot|overline|underline|overrightarrow|overleftarrow)_([A-Za-z0-9])/g, '\\$1{$2}')
    .replace(/_\\text\{([^{}]*)\}_([A-Za-z0-9])/g, '_{\\text{$1}_{$2}}')
    .replace(/_([A-Za-z]+)_([A-Za-z0-9])/g, '_{$1_$2}')
    .replace(/_([0-9])_([A-Za-z0-9])/g, '_{$1_$2}')
    .replace(/\\ChemForm\s+([A-Z][a-z]?)/g, '\\mathrm{$1}')
    .replace(/\\ChemForm([A-Z][a-z]?)(?![A-Za-z])/g, '\\mathrm{$1}')
    .replace(/\\ChemForm(?![A-Za-z])/g, '');
}

function sanitizeLatex(value) {
  return fixKnownLatexTypos(stripInvisibleChars(value))
    .replace(/[α-ωΑ-Ωµ]/g, (ch) => `\\ensuremath{${GREEK_TO_LATEX[ch] || ch}}`)
    .replace(/²/g, '\\ensuremath{{}^{2}}')
    .replace(/³/g, '\\ensuremath{{}^{3}}')
    .replace(/ℰ/g, '\\ensuremath{\\mathcal{E}}')
    .replace(/ʋ/g, '\\ensuremath{\\upsilon}')
    .replace(/[óό]/g, 'о')
    .replace(/[º°]/g, '\\ensuremath{^\\circ}')
    .replace(/[′’]/g, "'")
    .replace(/‚/g, ',')
    .replace(/→/g, '\\ensuremath{\\to}')
    .replace(/←/g, '\\ensuremath{\\leftarrow}')
    .replace(/↑/g, '\\ensuremath{\\uparrow}')
    .replace(/↓/g, '\\ensuremath{\\downarrow}')
    .replace(/≈/g, '\\ensuremath{\\approx}')
    .replace(/[≤⩽]/g, '\\ensuremath{\\le}')
    .replace(/[≥⩾]/g, '\\ensuremath{\\ge}')
    .replace(/≠/g, '\\ensuremath{\\ne}')
    .replace(/−/g, '-')
    .replace(/–/g, '-')
    .replace(/·/g, '\\ensuremath{\\cdot}')
    .replace(/±/g, '\\ensuremath{\\pm}');
}

function compactFigureLatex(latex) {
  return String(latex || '')
    .replace(
      /\\begin\{center\}\s*\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}\s*\\end\{center\}/g,
      (_m, imgPath) => `\\kimimg{${imgPath}}`
    )
    .replace(/\\begin\{center\}\s*([\s\S]*?)\s*\\end\{center\}/g, '$1')
    // Вложенные \begin{center} (встречаются внутри ячеек tabular) нельзя
    // оставлять: center в LR-режиме ячейки даёт «Misplaced \cr».
    .replace(/\\begin\{center\}/g, '')
    .replace(/\\end\{center\}/g, '');
}

function escapeLatex(value) {
  return String(value == null ? '' : value).replace(/_/g, '\\_');
}

function escapeAnswerCell(value) {
  return sanitizeLatex(value)
    .replace(/(^|[^\\])&/g, '$1\\&')
    .replace(/(^|[^\\])%/g, '$1\\%')
    .replace(/(^|[^\\])#/g, '$1\\#');
}

module.exports = {
  stripInvisibleChars,
  fixKnownLatexTypos,
  sanitizeLatex,
  compactFigureLatex,
  escapeLatex,
  escapeAnswerCell
};
