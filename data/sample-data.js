/* TELETEXT LIVES — data/sample-data.js
 * Kiroween 2026 — Category: Resurrection
 * Bundled sample data: labelled fallback scores (T8), quiz sets (T9),
 * and the page-888 subtitle script (T9).
 *
 * footballSamples is ALWAYS shown with the on-screen label
 * "SAMPLE DATA — live scores unavailable". Never present as live.
 */

window.SAMPLE_DATA = {

  /* ── footballSamples ──────────────────────────────────────────
   * One array per league key. Each entry: { home, away, score, status }
   *   status: 'FT' | 'HT' | 'PP' | '67\'' | '20:00' etc.
   * League keys: ENG, ESP, ITA, GER, UCL
   * ─────────────────────────────────────────────────────────── */
  footballSamples: {
    ENG: {
      name: 'PREMIER LEAGUE',
      matches: [
        { home: 'Man City',      away: 'Arsenal',      score: '2-1', status: 'FT'    },
        { home: 'Liverpool',     away: 'Chelsea',       score: '1-1', status: 'FT'    },
        { home: 'Man Utd',       away: 'Tottenham',     score: '0-2', status: 'FT'    },
        { home: 'Newcastle',     away: 'Aston Villa',   score: '3-0', status: 'FT'    },
        { home: 'Brighton',      away: 'Wolves',        score: '2-2', status: 'FT'    },
        { home: 'Everton',       away: 'Brentford',     score: '1-0', status: 'FT'    },
        { home: 'Fulham',        away: 'Crystal Palace',score: '0-1', status: 'FT'    },
        { home: 'Nottm Forest',  away: 'Bournemouth',   score: '--', status: '15:00'  },
      ],
    },
    ESP: {
      name: 'LA LIGA',
      matches: [
        { home: 'Real Madrid',   away: 'Barcelona',     score: '3-2', status: 'FT'    },
        { home: 'Atletico',      away: 'Sevilla',       score: '1-0', status: 'FT'    },
        { home: 'Villarreal',    away: 'Real Sociedad', score: '2-1', status: 'FT'    },
        { home: 'Athletic',      away: 'Valencia',      score: '0-0', status: 'FT'    },
        { home: 'Betis',         away: 'Girona',        score: '1-2', status: 'FT'    },
        { home: 'Osasuna',       away: 'Getafe',        score: '--', status: '17:00'  },
        { home: 'Celta Vigo',    away: 'Rayo',          score: '--', status: '19:30'  },
      ],
    },
    ITA: {
      name: 'SERIE A',
      matches: [
        { home: 'Inter Milan',   away: 'AC Milan',      score: '2-0', status: 'FT'    },
        { home: 'Juventus',      away: 'Napoli',        score: '1-1', status: 'FT'    },
        { home: 'Roma',          away: 'Lazio',         score: '0-2', status: 'FT'    },
        { home: 'Fiorentina',    away: 'Atalanta',      score: '1-3', status: 'FT'    },
        { home: 'Torino',        away: 'Bologna',       score: '2-1', status: 'FT'    },
        { home: 'Genoa',         away: 'Udinese',       score: '0-0', status: 'FT'    },
        { home: 'Cagliari',      away: 'Lecce',         score: '--', status: '18:00'  },
      ],
    },
    GER: {
      name: 'BUNDESLIGA',
      matches: [
        { home: 'Bayern Munich', away: 'Dortmund',      score: '4-2', status: 'FT'    },
        { home: 'Leverkusen',    away: 'Leipzig',       score: '1-0', status: 'FT'    },
        { home: 'Dortmund',      away: 'Frankfurt',     score: '2-2', status: 'FT'    },
        { home: 'Stuttgart',     away: 'Wolfsburg',     score: '3-1', status: 'FT'    },
        { home: 'Hoffenheim',    away: 'Freiburg',      score: '0-1', status: 'FT'    },
        { home: 'Union Berlin',  away: 'Augsburg',      score: '1-1', status: 'FT'    },
        { home: 'Mainz',         away: 'Bochum',        score: '--', status: '16:30'  },
      ],
    },
    UCL: {
      name: 'CHAMPIONS LEAGUE',
      matches: [
        { home: 'Man City',      away: 'Real Madrid',   score: '2-1', status: 'FT'    },
        { home: 'Bayern Munich', away: 'PSG',           score: '3-0', status: 'FT'    },
        { home: 'Inter Milan',   away: 'Barcelona',     score: '1-2', status: 'FT'    },
        { home: 'Arsenal',       away: 'Porto',         score: '2-0', status: 'FT'    },
        { home: 'Atletico',      away: 'Dortmund',      score: '1-1', status: 'FT'    },
        { home: 'Leverkusen',    away: 'AC Milan',      score: '0-0', status: 'FT'    },
        { home: 'Liverpool',     away: 'Benfica',       score: '--', status: '21:00'  },
        { home: 'Chelsea',       away: 'Ajax',          score: '--', status: '21:00'  },
      ],
    },
  },

  /* ── quizSets ─────────────────────────────────────────────────
   * 3 sets of 5 questions, rotated by (dayOfMonth % 3).
   * Each entry: { q, a }
   * Populated in T9.
   * ─────────────────────────────────────────────────────────── */
  quizSets: [
    [
      { q: 'What year did Ceefax launch on BBC2?',          a: '1974' },
      { q: 'Which planet is closest in size to Earth?',     a: 'Venus' },
      { q: 'How many time zones does Indonesia span?',      a: '3' },
      { q: 'What currency does Japan use?',                  a: 'Yen' },
      { q: 'Who painted the Mona Lisa?',                     a: 'Leonardo da Vinci' },
    ],
    [
      { q: 'In what year did the Berlin Wall fall?',         a: '1989' },
      { q: 'What is the capital of Indonesia?',              a: 'Jakarta' },
      { q: 'How many players in a football team?',           a: '11' },
      { q: 'What gas do plants absorb from the air?',        a: 'Carbon dioxide' },
      { q: 'Which ocean borders Indonesia to the south?',    a: 'Indian Ocean' },
    ],
    [
      { q: 'What is 17 multiplied by 6?',                    a: '102' },
      { q: 'Who wrote Romeo and Juliet?',                    a: 'Shakespeare' },
      { q: 'What is the boiling point of water in Celsius?', a: '100' },
      { q: 'Which country won the 2022 FIFA World Cup?',     a: 'Argentina' },
      { q: 'What does BBC stand for?',                       a: 'British Broadcasting Corporation' },
    ],
  ],

  /* ── subtitleScript ───────────────────────────────────────────
   * Array of lines for page 888's fake documentary.
   * Each string is one subtitle screen (up to ~80 chars, may wrap).
   * Populated in T9.
   * ─────────────────────────────────────────────────────────── */
  subtitleScript: [
    'Deep in the Indonesian archipelago,',
    'where seventeen thousand islands scatter across the equator,',
    'something ancient stirs.',
    '',
    'The Javan rhinoceros — fewer than eighty remain.',
    'Each footstep in the mud is a small miracle.',
    '',
    'The orangutan watches from the canopy.',
    'She has watched humans come and go for forty years.',
    '',
    'Tonight, the forest breathes differently.',
    'A signal, perhaps. Or simply the wind.',
    '',
    'Tomorrow, the scientists return with their cameras.',
    'The forest will be patient.',
    'It always is.',
    '',
    '[ END OF SUBTITLES ]',
    '',
    'Teletext subtitles have served deaf and hard-of-hearing',
    'viewers since 1980. Page 888 was always theirs first.',
  ],
};
