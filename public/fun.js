// Things to do while waiting in line: photo quests (Halloween at Walibi) and ride facts + quiz questions.
// FACTS come from rcdb.com, Wikipedia and walibi.be (sources per ride); only sourced numbers, no guesses.

// One quest per queue; the photo goes to the album with the quest as its caption (and in "Ons dagverslag").
export const QUESTS = [
  'Zoek een pompoen 🎃',
  'Trek allemaal je engste gezicht 😱',
  'Iets oranje in de rij 🟠',
  'Een spin of spinnenweb 🕷️',
  'Iemand verkleed als monster 🧟 (vraag het eerst even)',
  'Doe allemaal alsof je heel bang bent 😨',
  'Een heks, spook of vleermuis 🦇',
  'De attractie achter jullie, met jullie ervoor 🎢',
  'Zoek een doodshoofd of skelet 💀',
  'Het grappigste bordje in de rij 🪧',
  'Iedereen doet een superheldenpose 🦸',
  'Jullie schaduwen op de grond 👥',
  'Iets dat begint met de letter W (van Walibi) 🔤',
  'Een kleur van de regenboog: zoek alle 7! 🌈',
  'Kijk omhoog: wat zie je boven de rij? ☁️',
  'Iedereen steekt duimen omhoog 👍',
];

// FACTS[ride name] = { facts: [string], quiz: [{ q, options: [3], answer: 0-based, why }], sources: [url] }
export const FACTS = {};
