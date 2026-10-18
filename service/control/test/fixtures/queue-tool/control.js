// Test fixture: a control entry adding one MCP tool that uses the services.
export default function queueTool(yolo) {
  yolo.registerTool({
    name: "queue_greeting", title: "Greet", description: "Greets and says how many items are queued.", scope: "read",
    annotations: { readOnlyHint: true }, input: yolo.z.object({ who: yolo.z.string().optional() }),
    run: async (args, { services }) => ({ greeting: `${yolo.options.greeting}, ${args.who ?? "agent"}`, queued: (await services.listQueue()).length }),
  });
}
