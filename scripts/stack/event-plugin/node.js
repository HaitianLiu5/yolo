// One game in a library of events, played through whichever source claims the
// page in the options (Agent Note 2026-11-06-event-libraries).
export default function eventPlugin(yolo) {
  const game = {
    id: "g1", kind: "event", title: "Home vs Away", parents: ["g1"],
    event: { status: "ended", startsAt: "2026-11-05T00:30:00Z", competition: "League Cup", sides: [{ name: "Home", score: 101 }, { name: "Away", score: 99 }] },
  };
  const versions = [
    { id: "g1", kind: "event", title: "Whole game", duration: 120, parents: ["g1"] },
    { id: "g1.q1", kind: "event", title: "First quarter", duration: 30, parents: ["g1"] },
  ];
  yolo.registerSource("fixture-events", {
    libraries: async () => [{ id: "league", title: "League", type: "event" }],
    items: async () => ({ total: 1, offset: 0, items: [game] }),
    children: async () => ({ parent: game, items: versions }),
    describe: async () => ({ title: game.title, duration: null, isLive: false }),
    details: async () => ({ title: game.title, kind: "event", event: game.event }),
    delegate: async ({ id }) => ({ url: yolo.options.page, title: id === "g1" ? game.title : `${game.title} · First quarter`, parents: ["g1"] }),
  });
}
