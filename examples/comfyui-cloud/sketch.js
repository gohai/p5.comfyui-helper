// Running a workflow on Comfy Cloud instead of a local ComfyUI instance.
//
// Two things are different from the other examples:
//
// 1. you pass a Comfy Cloud API key (from https://platform.comfy.org) as the
//    second argument
// 2. you point the helper at a CORS proxy rather than at cloud.comfy.org --
//    cloud.comfy.org doesn't allow browser pages to call its API directly,
//    so a sketch can't reach it without one. See proxy/ in this repository
//    for a Cloudflare Worker you can deploy in a couple of minutes.
//
// Everything after that is the same as the local examples.

// the URL of your deployed proxy, e.g. "https://<name>.<subdomain>.workers.dev"
const PROXY_URL = "https://your-proxy.workers.dev";
// your own key -- each person using the proxy authenticates with their own,
// and generations are billed against their own Comfy Cloud credits
const API_KEY = "your-api-key";

let workflow;
let comfy;
let resImg;

function preload() {
  workflow = loadJSON("workflow_api.json");
}

function setup() {
  createCanvas(512, 512);

  comfy = new ComfyUiP5Helper(PROXY_URL, API_KEY);
  console.log("workflow is", workflow);

  let button = createButton("generate");
  button.mousePressed(requestImage);
}

function requestImage() {
  workflow[3].inputs.seed = random(9999999);

  comfy.run(workflow, gotImage);
}

function gotImage(results, err) {
  console.log("gotImage", results);

  if (err) {
    // e.g. an invalid API key, or being out of credits
    console.warn("Generation failed:", err);
    return;
  }

  if (results.length > 0) {
    resImg = loadImage(results[0].src);
  }
}

function draw() {
  background(255);
  // if we have an image, put it onto the canvas
  if (resImg) {
    image(resImg, 0, 0, width, height);
  }
}
