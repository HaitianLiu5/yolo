import assert from "node:assert/strict";
import test from "node:test";

import { warmAudioOutput } from "../../src/audio-output.js";

class FakeContext {
  static made = 0;
  constructor() {
    FakeContext.made += 1;
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}

test("the first tap opens the audio output after its own handlers, and only for the canvas engine", () => {
  const tasks = [];
  const defer = (task) => tasks.push(task);
  FakeContext.made = 0;

  // A <video> element needs the tap alone.
  assert.equal(warmAudioOutput({ engine: "native", AudioContextClass: FakeContext, defer }), false);
  assert.equal(tasks.length, 0);

  assert.equal(warmAudioOutput({ engine: "canvas", AudioContextClass: FakeContext, defer }), true);
  assert.equal(FakeContext.made, 0, "nothing opens while the tap's handlers run");
  tasks.shift()();
  assert.equal(FakeContext.made, 1);
});
