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
export const FACTS = {
 "Kondaa": {
  "facts": [
   "Kondaa gaat tot 113 km/u. Bij de opening was hij de snelste en hoogste achtbaan van België, Nederland en Luxemburg.",
   "Kondaa is 50 meter hoog en de baan is 1200 meter lang.",
   "Tijdens één rit van anderhalve minuut kom je 15 keer even los van je stoel: dat heet airtime.",
   "Kondaa opende op 8 mei 2021 en werd gebouwd door Intamin uit Zwitserland."
  ],
  "quiz": [
   {
    "q": "Hoe snel gaat Kondaa?",
    "options": [
     "80 km/u",
     "113 km/u",
     "150 km/u"
    ],
    "answer": 1,
    "why": "Kondaa haalt 113 km/u."
   },
   {
    "q": "Hoe vaak voel je airtime in Kondaa?",
    "options": [
     "3 keer",
     "8 keer",
     "15 keer"
    ],
    "answer": 2,
    "why": "Kondaa heeft 15 airtime-momenten."
   }
  ],
  "sources": [
   "https://rcdb.com/15207.htm",
   "https://nl.wikipedia.org/wiki/Kondaa",
   "https://coasterpedia.net/wiki/Kondaa"
  ]
 },
 "Pulsar": {
  "facts": [
   "Pulsar was de allereerste PowerSplash ter wereld, gebouwd door Mack Rides uit Duitsland.",
   "Pulsar schiet je 45 meter de lucht in en haalt 101 km/u.",
   "Bovenaan sta je helemaal recht omhoog: 90 graden!",
   "Er zijn 2 boten met elk plaats voor 20 mensen. Pulsar opende in 2016."
  ],
  "quiz": [
   {
    "q": "Hoe hoog gaat Pulsar?",
    "options": [
     "15 meter",
     "45 meter",
     "100 meter"
    ],
    "answer": 1,
    "why": "Pulsar gaat 45 meter hoog, recht omhoog."
   },
   {
    "q": "Wat is speciaal aan het einde van Pulsar?",
    "options": [
     "Je maakt een grote plons in het water",
     "Je rijdt in een tunnel",
     "Je gaat ondersteboven"
    ],
    "answer": 0,
    "why": "Pulsar is een waterachtbaan en eindigt met een splash."
   }
  ],
  "sources": [
   "https://rcdb.com/12409.htm",
   "https://www.walibi.be/nl/ontdek-het-park/sensatie-attracties/pulsar",
   "https://nl.wikipedia.org/wiki/Pulsar_(Walibi_Belgium)",
   "https://coasterpedia.net/wiki/Pulsar"
  ]
 },
 "Cobra": {
  "facts": [
   "Cobra rijdt eerst vooruit en daarna achteruit door dezelfde baan.",
   "Daardoor ga je in één rit 6 keer ondersteboven.",
   "Cobra haalt bijna 76 km/u en is 35,5 meter hoog.",
   "Cobra is een Boomerang van Vekoma en opende op 28 april 2001."
  ],
  "quiz": [
   {
    "q": "Hoe vaak ga je ondersteboven in Cobra?",
    "options": [
     "2 keer",
     "6 keer",
     "10 keer"
    ],
    "answer": 1,
    "why": "Je gaat 3 keer vooruit en 3 keer achteruit ondersteboven."
   },
   {
    "q": "In welke richting rijdt Cobra?",
    "options": [
     "Alleen vooruit",
     "Alleen achteruit",
     "Eerst vooruit, dan achteruit"
    ],
    "answer": 2,
    "why": "Cobra is een Boomerang: heen en terug door dezelfde baan."
   }
  ],
  "sources": [
   "https://rcdb.com/1028.htm",
   "https://www.walibi.be/nl/ontdek-het-park/sensatie-attracties/cobra",
   "https://nl.wikipedia.org/wiki/Cobra_(Walibi_Belgium)",
   "https://coasterpedia.net/wiki/Cobra_(Walibi_Belgium)"
  ]
 },
 "Vampire": {
  "facts": [
   "In Vampire hang je onder de baan, met je voeten in de lucht.",
   "Je gaat 5 keer ondersteboven en haalt 80 km/u.",
   "De baan is 689 meter lang en 33 meter hoog.",
   "Vampire opende in 1999 en werd gebouwd door Vekoma uit Nederland."
  ],
  "quiz": [
   {
    "q": "Hoe zit je in Vampire?",
    "options": [
     "Je hangt onder de baan",
     "Je zit in een boot",
     "Je staat recht"
    ],
    "answer": 0,
    "why": "Vampire is een hangende achtbaan: je voeten bengelen in de lucht."
   },
   {
    "q": "Hoe vaak ga je ondersteboven in Vampire?",
    "options": [
     "1 keer",
     "5 keer",
     "12 keer"
    ],
    "answer": 1,
    "why": "Vampire heeft 5 inversies."
   }
  ],
  "sources": [
   "https://rcdb.com/922.htm",
   "https://www.walibi.be/nl/ontdek-het-park/sensatie-attracties/vampire",
   "https://nl.wikipedia.org/wiki/Vampire_(Walibi_Belgium)",
   "https://coasterpedia.net/wiki/Vampire_(Walibi_Belgium)"
  ]
 },
 "Loup-Garou": {
  "facts": [
   "Loup-Garou is een achtbaan van hout. 'Loup-garou' is Frans voor weerwolf.",
   "De houten baan is 1035 meter lang en gaat tot 80 km/u.",
   "Loup-Garou opende in 2001. Het is een van maar drie houten achtbanen die Vekoma ooit bouwde.",
   "Walibi kondigde aan dat Loup-Garou op 3 januari 2027 afscheid neemt en in 2028 terugkomt als gloednieuwe RMC-achtbaan."
  ],
  "quiz": [
   {
    "q": "Wat betekent 'Loup-Garou'?",
    "options": [
     "Vampier",
     "Draak",
     "Weerwolf"
    ],
    "answer": 2,
    "why": "Loup-garou is het Franse woord voor weerwolf."
   },
   {
    "q": "Waarvan is de baan van Loup-Garou gemaakt?",
    "options": [
     "Hout",
     "Plastic",
     "Glas"
    ],
    "answer": 0,
    "why": "Loup-Garou is een houten achtbaan."
   }
  ],
  "sources": [
   "https://rcdb.com/1029.htm",
   "https://www.walibi.be/nl/ontdek-het-park/sensatie-attracties/loup-garou",
   "https://nl.wikipedia.org/wiki/Weerwolf_(achtbaan)",
   "https://fr.wikipedia.org/wiki/Loup_Garou_(Walibi_Belgium)"
  ]
 },
 "Turbine": {
  "facts": [
   "Turbine is de oudste achtbaan van Walibi: hij rijdt al sinds 1982.",
   "Hij heette eerst Sirocco, daarna Turbine, toen Psyké Underground en sinds 2025 weer Turbine.",
   "Je wordt gelanceerd tot 85 km/u en gaat door een looping, vooruit én achteruit.",
   "Een rit duurt maar 35 seconden. Het is de enige shuttle-loop-achtbaan die helemaal binnen staat."
  ],
  "quiz": [
   {
    "q": "Hoe heette Turbine vroeger?",
    "options": [
     "Kondaa",
     "Psyké Underground",
     "Space Mountain"
    ],
    "answer": 1,
    "why": "Van 2013 tot 2024 heette Turbine Psyké Underground."
   },
   {
    "q": "Hoe lang duurt een rit in Turbine?",
    "options": [
     "5 minuten",
     "10 minuten",
     "35 seconden"
    ],
    "answer": 2,
    "why": "Turbine is kort maar krachtig: 35 seconden."
   }
  ],
  "sources": [
   "https://rcdb.com/921.htm",
   "https://www.walibi.be/nl/ontdek-het-park/sensatie-attracties/turbine",
   "https://nl.wikipedia.org/wiki/Turbine_(Walibi_Belgium)",
   "https://coasterpedia.net/wiki/Turbine_(Walibi_Belgium)"
  ]
 },
 "Calamity Mine": {
  "facts": [
   "Calamity Mine is een mijntrein-achtbaan die opende in 1992.",
   "Tot 1997 heette hij Colorado.",
   "De baan is 785 meter lang en de trein haalt 48 km/u.",
   "Een rit duurt 2 minuten en 20 seconden, en je gaat nooit ondersteboven."
  ],
  "quiz": [
   {
    "q": "Hoe heette Calamity Mine vroeger?",
    "options": [
     "Colorado",
     "Texas",
     "Alaska"
    ],
    "answer": 0,
    "why": "Calamity Mine heette van 1992 tot 1997 Colorado."
   },
   {
    "q": "Hoe vaak ga je ondersteboven in Calamity Mine?",
    "options": [
     "2 keer",
     "Nooit",
     "5 keer"
    ],
    "answer": 1,
    "why": "Calamity Mine heeft geen inversies."
   }
  ],
  "sources": [
   "https://rcdb.com/924.htm",
   "https://www.walibi.be/nl/ontdek-het-park/familieattracties/calamity-mine",
   "https://nl.wikipedia.org/wiki/Calamity_Mine",
   "https://coasterpedia.net/wiki/Calamity_Mine"
  ]
 },
 "Tiki-Waka": {
  "facts": [
   "Tiki-Waka is een bobslee-achtbaan van Gerstlauer uit Duitsland.",
   "Elk wagentje heeft plaats voor 4 mensen: 2 rijen van 2.",
   "De baan is 564 meter lang, 21 meter hoog en je gaat tot 55 km/u.",
   "Tiki-Waka opende in 2018, op de plek waar vroeger het kinderachtbaantje Coccinelle stond."
  ],
  "quiz": [
   {
    "q": "Hoeveel mensen passen in één wagentje van Tiki-Waka?",
    "options": [
     "2",
     "4",
     "20"
    ],
    "answer": 1,
    "why": "Elk wagentje heeft 2 rijen van 2 plaatsen."
   }
  ],
  "sources": [
   "https://rcdb.com/15205.htm",
   "https://www.walibi.be/nl/ontdek-het-park/familieattracties/tiki-waka",
   "https://nl.wikipedia.org/wiki/Tiki_Waka",
   "https://coasterpedia.net/wiki/Tiki-Waka"
  ]
 },
 "Mecalodon": {
  "facts": [
   "Mecalodon is 925 meter lang: de langste familieachtbaan van de Benelux.",
   "De treinen zien eruit als mechanische haaien, geïnspireerd op de megalodon, een uitgestorven reuzenhaai.",
   "Je wordt 3 keer gelanceerd en voelt 14 keer airtime. Topsnelheid: 65 km/u.",
   "Mecalodon opende op 5 april 2025, toen Walibi 50 jaar bestond."
  ],
  "quiz": [
   {
    "q": "Op welk dier lijken de treinen van Mecalodon?",
    "options": [
     "Een haai",
     "Een slang",
     "Een draak"
    ],
    "answer": 0,
    "why": "De treinen zijn mechanische haaien, naar de megalodon."
   },
   {
    "q": "Hoe vaak word je gelanceerd in Mecalodon?",
    "options": [
     "1 keer",
     "3 keer",
     "7 keer"
    ],
    "answer": 1,
    "why": "Mecalodon heeft 3 lanceringen."
   }
  ],
  "sources": [
   "https://rcdb.com/21793.htm",
   "https://www.walibi.be/nl/ontdek-het-park/familieattracties/mecalodon",
   "https://nl.wikipedia.org/wiki/Mecalodon"
  ]
 },
 "Fun Pilot": {
  "facts": [
   "Fun Pilot is een kinderachtbaan met een vliegtuigthema: het voorste karretje is een vliegtuig.",
   "Je rijdt de baan twee keer na elkaar.",
   "Fun Pilot is 9,5 meter hoog en gaat tot 40 km/u.",
   "Hij werd gebouwd door Zierer uit Duitsland en opende in 2019."
  ],
  "quiz": [
   {
    "q": "Hoe vaak rijd je de baan van Fun Pilot in één rit?",
    "options": [
     "1 keer",
     "2 keer",
     "5 keer"
    ],
    "answer": 1,
    "why": "De baan van Fun Pilot wordt twee keer doorlopen."
   }
  ],
  "sources": [
   "https://rcdb.com/15206.htm",
   "https://www.walibi.be/nl/ontdek-het-park/attracties-voor-kinderen/fun-pilot",
   "https://nl.wikipedia.org/wiki/Fun_Pilot"
  ]
 },
 "Dalton Terror": {
  "facts": [
   "Dalton Terror is een vrije-valtoren van 77 meter hoog. Je ziet hem bijna overal in het park.",
   "Hij opende in 1998 en werd gebouwd door Intamin uit Zwitserland.",
   "Vroeger stonden de Daltons uit de strip Lucky Luke op de toren.",
   "Guitar Riff in Adventure World is zijn 'kleine broertje' voor kleine waaghalzen."
  ],
  "quiz": [
   {
    "q": "Wat is hoger: Dalton Terror of Kondaa?",
    "options": [
     "Dalton Terror",
     "Kondaa",
     "Ze zijn even hoog"
    ],
    "answer": 0,
    "why": "Dalton Terror is 77 meter, Kondaa 50 meter."
   },
   {
    "q": "Uit welke strip kwamen de Daltons?",
    "options": [
     "Kuifje",
     "Lucky Luke",
     "Suske en Wiske"
    ],
    "answer": 1,
    "why": "De Daltons zijn de boeven uit Lucky Luke."
   }
  ],
  "sources": [
   "https://nl.wikipedia.org/wiki/Dalton_Terror",
   "https://fr.wikipedia.org/wiki/Dalton_Terror",
   "https://www.walibi.be/nl/ontdek-het-park/sensatie-attracties/dalton-terror",
   "https://www.walibi.be/nl/ontdek-het-park/attracties-voor-kinderen/guitar-riff",
   "https://coasterpedia.net/wiki/Dalton_Terror"
  ]
 },
 "Radja River": {
  "facts": [
   "Radja River is een wildwaterbaan uit 1988, gebouwd door Intamin.",
   "In één ronde boot kunnen 12 mensen. Bij de meeste wildwaterbanen zijn dat er minder.",
   "De rivier is 600 meter lang.",
   "Walibi waarschuwt: dit avontuur wordt een beetje... nat!"
  ],
  "quiz": [
   {
    "q": "Hoeveel mensen passen er in een boot van Radja River?",
    "options": [
     "4",
     "12",
     "30"
    ],
    "answer": 1,
    "why": "Een boot van Radja River heeft 12 plaatsen."
   },
   {
    "q": "In welk jaar opende Radja River?",
    "options": [
     "1988",
     "2015",
     "2024"
    ],
    "answer": 0,
    "why": "Radja River opende in 1988."
   }
  ],
  "sources": [
   "https://nl.wikipedia.org/wiki/Radja_River",
   "https://fr.wikipedia.org/wiki/Radja_River",
   "https://www.walibi.be/nl/ontdek-het-park/familieattracties/radja-river"
  ]
 },
 "Challenge of Tutankhamon": {
  "facts": [
   "In deze darkride schiet je met een laserpistool op doelen om punten te verdienen. Er zijn 130 doelen.",
   "Met genoeg punten versla je de gouden Seth en mag je de schatkamer in.",
   "Er rijden 13 wagens met elk 6 plaatsen, zonder rails.",
   "De rit opende in 2003 en won prijzen, zoals een Thea Award."
  ],
  "quiz": [
   {
    "q": "Wat heb je nodig om in de schatkamer te komen?",
    "options": [
     "Een sleutel",
     "Genoeg punten",
     "Een kaartje"
    ],
    "answer": 1,
    "why": "Alleen met genoeg punten versla je Seth en kom je in de schatkamer."
   },
   {
    "q": "Hoeveel mensen passen in één wagen?",
    "options": [
     "2",
     "6",
     "20"
    ],
    "answer": 1,
    "why": "Elke wagen heeft 6 plaatsen."
   }
  ],
  "sources": [
   "https://sallydarkrides.com/dark-rides/challenge-of-tut",
   "https://nl.wikipedia.org/wiki/Challenge_of_Tutankhamon",
   "https://www.walibi.be/nl/ontdek-het-park/familieattracties/challenge-of-tutankhamon"
  ]
 },
 "Popcorn Revenge": {
  "facts": [
   "In Popcorn Revenge schiet je op popcorn op grote schermen.",
   "De wagens hebben geen vaste route: elke rit kan anders zijn.",
   "Er zijn 7 wagens met elk 6 spelers.",
   "Popcorn Revenge opende in 2019 en won een Thea Award, een belangrijke prijs voor attracties."
  ],
  "quiz": [
   {
    "q": "Waarop schiet je in Popcorn Revenge?",
    "options": [
     "Popcorn",
     "Ballonnen",
     "Mummies"
    ],
    "answer": 0,
    "why": "Je schiet op boze popcorn op de schermen."
   },
   {
    "q": "Rijdt elke wagen altijd dezelfde weg?",
    "options": [
     "Ja, altijd",
     "Nee, de route kan anders zijn",
     "Er is maar één wagen"
    ],
    "answer": 1,
    "why": "Popcorn Revenge heeft geen vaste route."
   }
  ],
  "sources": [
   "https://www.alterface.com/portfolio/popcorn-revenge-walibi-belgium/",
   "https://blooloop.com/technology/news/alterface-popcorn-revenge-thea-award/",
   "https://nl.wikipedia.org/wiki/Popcorn_Revenge",
   "https://www.walibi.be/nl/ontdek-het-park/familieattracties/popcorn-revenge"
  ]
 },
 "Flash Back": {
  "facts": [
   "In Flash Back gaat je bootje een afdaling achteruit naar beneden.",
   "De finale is een dubbele splash.",
   "De hoogste afdaling begint op 23 meter hoogte.",
   "Flash Back opende in 1995, toen Walibi 20 jaar bestond. Het verhaal: een fabriek die mensen jonger maakt."
  ],
  "quiz": [
   {
    "q": "Wat is speciaal aan een afdaling in Flash Back?",
    "options": [
     "Je gaat ondersteboven",
     "Je vliegt door de lucht",
     "Je gaat achteruit naar beneden"
    ],
    "answer": 2,
    "why": "Een draaischijf draait je bootje om, zodat je achteruit naar beneden gaat."
   }
  ],
  "sources": [
   "https://nl.wikipedia.org/wiki/Flash_Back",
   "https://fr.wikipedia.org/wiki/Flash_Back_(Walibi_Belgium)",
   "https://www.walibi.be/nl/ontdek-het-park/familieattracties/flash-back"
  ]
 },
 "Buzzsaw": {
  "facts": [
   "Buzzsaw ziet eruit als een grote zaag: er hangen nep-zaagbladen aan.",
   "Je gaat meerdere keren na elkaar met je hoofd naar beneden.",
   "Er kunnen 40 mensen tegelijk mee. Je moet minstens 140 cm groot zijn.",
   "Buzzsaw opende in 2001 onder de naam The Screamer en kreeg in 2007 zijn huidige naam."
  ],
  "quiz": [
   {
    "q": "Hoe heette Buzzsaw vroeger?",
    "options": [
     "The Screamer",
     "The Flyer",
     "The Spinner"
    ],
    "answer": 0,
    "why": "Van 2001 tot 2007 heette Buzzsaw The Screamer."
   }
  ],
  "sources": [
   "https://nl.wikipedia.org/wiki/Buzzsaw",
   "https://www.walibi.be/nl/ontdek-het-park/sensatie-attracties/buzzsaw",
   "https://coasterpedia.net/wiki/Buzzsaw_(Walibi_Belgium)",
   "https://fr.wikipedia.org/wiki/Walibi_Belgium"
  ]
 },
 "Silverton": {
  "facts": [
   "Silverton opende in de zomer van 2023, vlak bij Dalton Terror.",
   "De naam werd gekozen door fans van Walibi in een online wedstrijd.",
   "Silverton is een mijnstadje in de Rocky Mountains in Amerika, op 3000 meter hoogte. Er reed vroeger een trein naartoe.",
   "Je zit met z'n tweeën in een stoomlocomotiefje, en je kunt het zelf naar buiten laten zwaaien."
  ],
  "quiz": [
   {
    "q": "Wie koos de naam Silverton?",
    "options": [
     "De koning",
     "Fans van Walibi",
     "Een computer"
    ],
    "answer": 1,
    "why": "Fans kozen de naam in een online wedstrijd."
   },
   {
    "q": "Waarin zit je in Silverton?",
    "options": [
     "Een boot",
     "Een vliegtuig",
     "Een stoomlocomotiefje"
    ],
    "answer": 2,
    "why": "De wagentjes zijn tweezits stoomlocomotieven."
   }
  ],
  "sources": [
   "https://cdn.uc.assets.prezly.com/fa387ff9-805c-4d9c-b42f-06af1e1763cb/-/inline/no/Persdossier%20seizoen%202023.pdf",
   "https://www.walibi.be/nl/ontdek-het-park/familieattracties/silverton",
   "https://coasterpedia.net/wiki/Silverton"
  ]
 },
 "Octopus": {
  "facts": [
   "Octopus is gebouwd door Chance Rides, een bouwer uit Amerika.",
   "Er kunnen 40 mensen tegelijk mee: 20 bankjes voor 2.",
   "Een rit duurt 2 minuten en 45 seconden.",
   "Bovenaan zit een grote octopus, die in 2019 roze werd geverfd."
  ],
  "quiz": [
   {
    "q": "Hoeveel mensen kunnen tegelijk mee in Octopus?",
    "options": [
     "8",
     "40",
     "100"
    ],
    "answer": 1,
    "why": "Octopus heeft 20 bankjes voor 2 mensen."
   }
  ],
  "sources": [
   "https://nl.wikipedia.org/wiki/Octopus_(Walibi_Belgium)",
   "https://coasterpedia.net/wiki/Octopus_(Walibi_Belgium)",
   "https://www.walibi.be/nl/ontdek-het-park/familieattracties/octopus"
  ]
 },
 "Palais du Génie": {
  "facts": [
   "Palais du Génie is een 'Mad House' van Vekoma, vol optische illusies.",
   "De ondeugende geesten Zanzar en Babas testen of je je ogen kunt vertrouwen.",
   "Het paleis opende in 2001."
  ],
  "quiz": [
   {
    "q": "Hoe heten de geesten in Palais du Génie?",
    "options": [
     "Ali en Baba",
     "Zanzar en Babas",
     "Tik en Tak"
    ],
    "answer": 1,
    "why": "Zanzar en Babas zijn de ondeugende geesten van het paleis."
   }
  ],
  "sources": [
   "https://coasterpedia.net/wiki/Palais_du_Génie",
   "https://www.walibi.be/nl/ontdek-het-park/familieattracties/le-palais-du-genie",
   "https://fr.wikipedia.org/wiki/Walibi_Belgium"
  ]
 },
 "Spinning Vibe": {
  "facts": [
   "Spinning Vibe is een Breakdance van HUSS uit Duitsland.",
   "De bakjes zien eruit als drums, rond een stapel grote drums.",
   "Vroeger heette hij Barriques (wijnvaten) en daarna Cilindri Rotanti. Sinds 2013 heet hij Spinning Vibe.",
   "Er kunnen 32 mensen tegelijk mee."
  ],
  "quiz": [
   {
    "q": "Waarop lijken de bakjes van Spinning Vibe?",
    "options": [
     "Theekopjes",
     "Auto's",
     "Drums"
    ],
    "answer": 2,
    "why": "Spinning Vibe heeft een muziekthema met drums."
   }
  ],
  "sources": [
   "https://nl.wikipedia.org/wiki/Spinning_Vibe_(Walibi_Belgium)",
   "https://fr.wikipedia.org/wiki/Walibi_Belgium",
   "https://www.walibi.be/nl/ontdek-het-park/sensatie-attracties/spinning-vibe"
  ]
 },
 "Wave Swinger": {
  "facts": [
   "Wave Swinger is een draaimolen en schommel in één.",
   "Er zijn 48 plaatsen in de zwierstoeltjes.",
   "Hij opende in 2001 en heette tot 2012 French Cancan. De bouwer is Zierer uit Duitsland."
  ],
  "quiz": [
   {
    "q": "Hoe heette Wave Swinger vroeger?",
    "options": [
     "French Cancan",
     "Belgian Waffle",
     "Dutch Dance"
    ],
    "answer": 0,
    "why": "Tot 2012 heette Wave Swinger French Cancan."
   }
  ],
  "sources": [
   "https://www.walibi.be/nl/ontdek-het-park/familieattracties/wave-swinger",
   "https://coasterpedia.net/wiki/Wave_Swinger_(Walibi_Belgium)",
   "https://fr.wikipedia.org/wiki/Walibi_Belgium"
  ]
 },
 "Kondaala": {
  "facts": [
   "Kondaala is een mini-versie van Kondaa voor kinderen.",
   "Er zijn 2 cabines met elk 10 plaatsen.",
   "Hij opende in 2001 en had al veel namen, zoals Yosemite Sam's Flight School en Squad's Stunt Flight.",
   "Sinds 2021 staat hij in Exotic World, in de zone van de grote Kondaa."
  ],
  "quiz": [
   {
    "q": "Van welke grote achtbaan is Kondaala de kleine versie?",
    "options": [
     "Cobra",
     "Kondaa",
     "Vampire"
    ],
    "answer": 1,
    "why": "Kondaala is gethematiseerd als een mini-Kondaa."
   }
  ],
  "sources": [
   "https://nl.wikipedia.org/wiki/Kondaala",
   "https://coasterpedia.net/wiki/Kondaala",
   "https://nl.wikipedia.org/wiki/Kondaa",
   "https://www.walibi.be/nl/ontdek-het-park/attracties-voor-kinderen/kondaala"
  ]
 },
 "Stormy": {
  "facts": [
   "Stormy heette van 1999 tot 2024 Dragon Boat, met bootjes als vikingschepen.",
   "Sinds 2025 staat Stormy in Dock World, met nieuwe bootjes.",
   "Er kunnen 36 kinderen en ouders tegelijk mee. De bouwer is Zierer uit Duitsland."
  ],
  "quiz": [
   {
    "q": "Op welke schepen leken de bootjes van Stormy vroeger?",
    "options": [
     "Piratenschepen",
     "Duikboten",
     "Vikingschepen"
    ],
    "answer": 2,
    "why": "Als Dragon Boat waren de bootjes vikingschepen."
   }
  ],
  "sources": [
   "https://nl.wikipedia.org/wiki/Stormy_(Walibi_Belgium)",
   "https://coasterpedia.net/wiki/Stormy",
   "https://www.walibi.be/nl/ontdek-het-park/attracties-voor-kinderen/stormy"
  ]
 },
 "Tous en Boîte": {
  "facts": [
   "In Tous en Boîte draai je rond in een blikje, als een sardientje.",
   "In het midden ontsnapt een reuzenkrab uit een blik.",
   "Tot 2024 heette de attractie Salsa y Fiesta. Ze draait al sinds 2001."
  ],
  "quiz": [
   {
    "q": "Wat ontsnapt er in het midden van Tous en Boîte?",
    "options": [
     "Een krab",
     "Een haai",
     "Een octopus"
    ],
    "answer": 0,
    "why": "Er ontsnapt een reuzenkrab uit een blik."
   }
  ],
  "sources": [
   "https://www.walibi.be/nl/ontdek-het-park/familieattracties/tous-en-boite",
   "https://coasterpedia.net/wiki/Tous_en_Boîte",
   "https://fr.wikipedia.org/wiki/Walibi_Belgium"
  ]
 },
 "Guitar Riff": {
  "facts": [
   "Guitar Riff is het kleine broertje van Dalton Terror: een mini-valtoren.",
   "Er kunnen 6 kinderen tegelijk mee.",
   "Hij heette vroeger Albero Magico, Italiaans voor 'toverboom'."
  ],
  "quiz": [
   {
    "q": "Van welke grote attractie is Guitar Riff het kleine broertje?",
    "options": [
     "Pulsar",
     "Dalton Terror",
     "Radja River"
    ],
    "answer": 1,
    "why": "Walibi noemt Guitar Riff het kleine broertje van Dalton Terror."
   }
  ],
  "sources": [
   "https://www.walibi.be/nl/ontdek-het-park/attracties-voor-kinderen/guitar-riff",
   "https://coasterpedia.net/wiki/Guitar_Riff",
   "https://fr.wikipedia.org/wiki/Walibi_Belgium"
  ]
 },
 "Kids Airlines": {
  "facts": [
   "In Kids Airlines kies je zelf hoe hoog je vliegt.",
   "Deze vliegtuigjes draaien al sinds 1975, het jaar waarin Walibi openging.",
   "Ze werden gebouwd door Marcel Lutz uit Frankrijk. Er kunnen 24 kinderen tegelijk mee."
  ],
  "quiz": [
   {
    "q": "Wat mag je zelf kiezen in Kids Airlines?",
    "options": [
     "Waar je landt",
     "Hoe lang het duurt",
     "Hoe hoog je vliegt"
    ],
    "answer": 2,
    "why": "Je bepaalt zelf hoe hoog je vliegtuigje gaat."
   }
  ],
  "sources": [
   "https://www.walibi.be/nl/ontdek-het-park/attracties-voor-kinderen/kids-airlines",
   "https://coasterpedia.net/wiki/Kids_Airlines",
   "https://fr.wikipedia.org/wiki/Walibi_Belgium"
  ]
 },
 "Poneys": {
  "facts": [
   "Bij Poneys maak je een ritje door een indianendorp.",
   "De attractie bestaat al sinds 1979.",
   "Van 1998 tot 2006 heette ze Jolly-Jumper Ranch, naar het paard van Lucky Luke."
  ],
  "quiz": [
   {
    "q": "Naar welk paard was Poneys vroeger genoemd?",
    "options": [
     "Jolly Jumper",
     "Black Beauty",
     "Spirit"
    ],
    "answer": 0,
    "why": "Ze heette Jolly-Jumper Ranch, naar het paard van Lucky Luke."
   }
  ],
  "sources": [
   "https://www.walibi.be/nl/ontdek-het-park/attracties-voor-kinderen/poneys",
   "https://fr.wikipedia.org/wiki/Walibi_Belgium",
   "https://en.wikipedia.org/wiki/Walibi_Belgium"
  ]
 },
 "Tiki-Trail": {
  "facts": [
   "Tiki-Trail is een avonturenparcours in Exotic World uit 2018.",
   "Er zijn 5 torens en 4 bruggen, waaronder een apenbrug.",
   "De torens zijn 7 meter hoog en één ervan heeft een glijbaan."
  ],
  "quiz": [
   {
    "q": "Hoeveel torens heeft Tiki-Trail?",
    "options": [
     "2",
     "5",
     "10"
    ],
    "answer": 1,
    "why": "Tiki-Trail heeft 5 torens en 4 bruggen."
   }
  ],
  "sources": [
   "https://fr.wikipedia.org/wiki/Walibi_Belgium",
   "https://www.walibi.be/nl/ontdek-het-park/familieattracties/tiki-trail"
  ]
 },
 "Melody Road": {
  "facts": [
   "Bij Melody Road rijd je zelf in een oud autootje, langzaam door het groen.",
   "Melody Road bestaat al sinds 1979.",
   "Vroeger heette de attractie onder meer Vieux Tacots ('oude barrels') en Boule et Bill Autostop."
  ],
  "quiz": [
   {
    "q": "Sinds wanneer kun je rijden op Melody Road?",
    "options": [
     "1979",
     "2010",
     "2024"
    ],
    "answer": 0,
    "why": "Melody Road rijdt al sinds 1979."
   }
  ],
  "sources": [
   "https://www.walibi.be/nl/ontdek-het-park/familieattracties/melody-road",
   "https://fr.wikipedia.org/wiki/Walibi_Belgium",
   "https://en.wikipedia.org/wiki/Walibi_Belgium"
  ]
 },
 "Grand Carrousel": {
  "facts": [
   "De Grand Carrousel draait sinds 1990.",
   "Tot 2000 heette hij Galopant.",
   "Hij werd gemaakt door Euro Sujets."
  ],
  "quiz": [
   {
    "q": "Hoe heette de Grand Carrousel vroeger?",
    "options": [
     "Galopant",
     "Trotteur",
     "Sprinter"
    ],
    "answer": 0,
    "why": "Van 1990 tot 2000 heette hij Galopant."
   }
  ],
  "sources": [
   "https://fr.wikipedia.org/wiki/Walibi_Belgium",
   "https://en.wikipedia.org/wiki/Walibi_Belgium",
   "https://www.walibi.be/nl/ontdek-het-park/familieattracties/Le-grand-carrousel"
  ]
 },
 "Tapis Volant": {
  "facts": [
   "Op het Vliegend Tapijt maak je een magische reis over de woestijn.",
   "Het staat in Karma World en draait sinds 2001."
  ],
  "quiz": [
   {
    "q": "Waarover vlieg je met het Tapis Volant?",
    "options": [
     "De zee",
     "De woestijn",
     "De sneeuw"
    ],
    "answer": 1,
    "why": "Walibi beschrijft een magische reis over de woestijn."
   }
  ],
  "sources": [
   "https://www.walibi.be/nl/ontdek-het-park/familieattracties/le-tapis-volant",
   "https://fr.wikipedia.org/wiki/Walibi_Belgium",
   "https://en.wikipedia.org/wiki/Walibi_Belgium"
  ]
 },
 "Bubble Swirl": {
  "facts": [
   "In Bubble Swirl draai je rond in een kleurrijke heteluchtballon.",
   "Hij opende in 2001 en heette eerst Elmer autour du monde, naar Elmer uit de Looney Tunes."
  ],
  "quiz": [
   {
    "q": "Waarin zit je in Bubble Swirl?",
    "options": [
     "Een raket",
     "Een treintje",
     "Een heteluchtballon"
    ],
    "answer": 2,
    "why": "De bakjes zijn kleurrijke heteluchtballonnen."
   }
  ],
  "sources": [
   "https://www.walibi.be/nl/ontdek-het-park/attracties-voor-kinderen/bubble-swirl",
   "https://fr.wikipedia.org/wiki/Walibi_Belgium",
   "https://en.wikipedia.org/wiki/Walibi_Belgium"
  ]
 },
 "Graffiti Shuttle": {
  "facts": [
   "Graffiti Shuttle is een Crazy Bus van Zamperla uit Italië.",
   "Hij opende in 2001 als 'Le sous-marin fou de Daffy': de gekke duikboot van Daffy Duck."
  ],
  "quiz": [
   {
    "q": "Van welke tekenfilmeend was Graffiti Shuttle vroeger?",
    "options": [
     "Daffy Duck",
     "Donald Duck",
     "Alfred J. Kwak"
    ],
    "answer": 0,
    "why": "Hij heette eerst 'Le sous-marin fou de Daffy'."
   }
  ],
  "sources": [
   "https://fr.wikipedia.org/wiki/Walibi_Belgium",
   "https://en.wikipedia.org/wiki/Walibi_Belgium",
   "https://www.walibi.be/nl/ontdek-het-park/attracties-voor-kinderen/graffiti-shuttle"
  ]
 },
 "Fun Recorder": {
  "facts": [
   "In Fun Recorder ga je zachtjes op en neer, en weer opnieuw.",
   "Hij heette tot 2004 'Avion-école Marvin le Martien', naar Marvin the Martian uit de Looney Tunes."
  ],
  "quiz": [
   {
    "q": "Wat doe je in Fun Recorder?",
    "options": [
     "Ondersteboven gaan",
     "Op en neer gaan",
     "In het water plonzen"
    ],
    "answer": 1,
    "why": "Fun Recorder laat je zachtjes op en neer gaan."
   }
  ],
  "sources": [
   "https://www.walibi.be/nl/ontdek-het-park/attracties-voor-kinderen/fun-recorder",
   "https://fr.wikipedia.org/wiki/Walibi_Belgium"
  ]
 },
 "Mini Tour": {
  "facts": [
   "Mini Tour is een treintje van Zamperla uit Italië, geopend in 2001.",
   "Het heette vroeger onder meer Mama Lily's Train en Wab Mini Tour."
  ],
  "quiz": [
   {
    "q": "Wat voor attractie is Mini Tour?",
    "options": [
     "Een valtoren",
     "Een waterbaan",
     "Een treintje"
    ],
    "answer": 2,
    "why": "Mini Tour is een treintje voor de kleinsten."
   }
  ],
  "sources": [
   "https://fr.wikipedia.org/wiki/Walibi_Belgium",
   "https://www.walibi.be/nl/ontdek-het-park/attracties-voor-kinderen/mini-tour"
  ]
 },
 "Spinning Taxi": {
  "facts": [
   "In Spinning Taxi kies je: rijd je zelf of laat je een taxichauffeur rijden?",
   "Vroeger heette deze attractie La Polizia en daarna Squad Taxi."
  ],
  "quiz": [
   {
    "q": "Hoe heette Spinning Taxi vroeger?",
    "options": [
     "La Polizia",
     "La Pizza",
     "La Pasta"
    ],
    "answer": 0,
    "why": "Van 2001 tot 2012 heette hij La Polizia."
   }
  ],
  "sources": [
   "https://www.walibi.be/nl/ontdek-het-park/attracties-voor-kinderen/spinning-taxi",
   "https://fr.wikipedia.org/wiki/Walibi_Belgium"
  ]
 },
 "Tchou-Tchou Express": {
  "facts": [
   "De Tchou-Tchou Express rijdt door een klein dorp met mooie huizen.",
   "Het treintje rijdt sinds 1990 en heette eerst Kangourouland."
  ],
  "quiz": [
   {
    "q": "Hoe heette de Tchou-Tchou Express in het begin?",
    "options": [
     "Koalaland",
     "Kangourouland",
     "Pinguïnland"
    ],
    "answer": 1,
    "why": "Van 1990 tot 1994 heette hij Kangourouland."
   }
  ],
  "sources": [
   "https://www.walibi.be/nl/ontdek-het-park/attracties-voor-kinderen/tchou-tchou-express",
   "https://fr.wikipedia.org/wiki/Walibi_Belgium",
   "https://en.wikipedia.org/wiki/Walibi_Belgium"
  ]
 },
 "Tree House": {
  "facts": [
   "Tree House is een grote buitenspeeltuin om te klimmen en te glijden.",
   "Tot 2004 heette het Looney Tunes Tree House."
  ],
  "quiz": [
   {
    "q": "Wat kun je doen in Tree House?",
    "options": [
     "Zwemmen",
     "Achtbaan rijden",
     "Klimmen en glijden"
    ],
    "answer": 2,
    "why": "Tree House is een speeltuin om te klimmen en te glijden."
   }
  ],
  "sources": [
   "https://www.walibi.be/nl/ontdek-het-park/attracties-voor-kinderen/tree-house",
   "https://fr.wikipedia.org/wiki/Walibi_Belgium"
  ]
 },
 "4x4 Adventure": {
  "facts": [
   "Bij 4x4 Adventure rijd je met een 4x4 over een oefenterrein.",
   "Het opende in 2001. Tot 2004 heette het 'Transports Taz & Co', naar Taz uit de Looney Tunes."
  ],
  "quiz": [
   {
    "q": "In wat voor auto rijd je bij 4x4 Adventure?",
    "options": [
     "Een 4x4",
     "Een raceauto",
     "Een bus"
    ],
    "answer": 0,
    "why": "Je rijdt in een 4x4 over een oefenterrein."
   }
  ],
  "sources": [
   "https://www.walibi.be/nl/ontdek-het-park/attracties-voor-kinderen/4x4-adventure",
   "https://fr.wikipedia.org/wiki/Walibi_Belgium"
  ]
 },
 "Little Swing": {
  "facts": [
   "Little Swing is een zweefmolen voor kinderen met stoeltjes die in de lucht hangen.",
   "Vroeger heette hij Abeilles Volantes ('vliegende bijen') en daarna Giostra di Miele."
  ],
  "quiz": [
   {
    "q": "Hoe heette Little Swing vroeger?",
    "options": [
     "Zwemmende vissen",
     "Vliegende bijen",
     "Springende kikkers"
    ],
    "answer": 1,
    "why": "Hij heette Abeilles Volantes: Frans voor vliegende bijen."
   }
  ],
  "sources": [
   "https://www.walibi.be/nl/ontdek-het-park/attracties-voor-kinderen/little-swing",
   "https://fr.wikipedia.org/wiki/Walibi_Belgium"
  ]
 },
 "4D Wanted Alive": {
  "facts": [
   "Deze 4D-bioscoop opende in 2005 met een film van SpongeBob.",
   "Het 4D-systeem komt van SimEx-Iwerks."
  ],
  "quiz": [
   {
    "q": "Met welke film opende de 4D-bioscoop in 2005?",
    "options": [
     "Een film van Kuifje",
     "Een film van Nijntje",
     "Een film van SpongeBob"
    ],
    "answer": 2,
    "why": "In 2005 draaide hier de 4D-film van SpongeBob."
   }
  ],
  "sources": [
   "https://fr.wikipedia.org/wiki/Walibi_Belgium",
   "https://en.wikipedia.org/wiki/Walibi_Belgium"
  ]
 }
};
