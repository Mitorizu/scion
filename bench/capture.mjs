// Records the request Pi sends to an Anthropic-compatible endpoint, then
// answers with a minimal valid stream so the turn completes. No model is
// called and nothing leaves the machine.
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

const outfile = process.argv[2];
const port = Number(process.argv[3] ?? 8788);
if (!outfile) {
	console.error("usage: node bench/capture.mjs <outfile.json> [port]");
	process.exit(1);
}

const message = {
	id: "bench",
	type: "message",
	role: "assistant",
	model: "bench",
	content: [],
	stop_reason: null,
	stop_sequence: null,
	usage: { input_tokens: 1, output_tokens: 1 },
};

const events = [
	["message_start", { type: "message_start", message }],
	["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
	["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
	["content_block_stop", { type: "content_block_stop", index: 0 }],
	["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
	["message_stop", { type: "message_stop" }],
];

createServer((request, response) => {
	let body = "";
	request.on("data", (chunk) => { body += chunk; });
	request.on("end", () => {
		writeFileSync(outfile, JSON.stringify({ path: request.url, body: JSON.parse(body || "{}") }, null, 2));
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		for (const [name, data] of events) response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
		response.end();
	});
}).listen(port, "127.0.0.1", () => console.log(`capture server on ${port}`));
