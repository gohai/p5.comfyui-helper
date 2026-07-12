// this example workflow expects v1-5-pruned-emaonly-fp16.safetensors to be installed

let workflow;
let comfy;
let resImg;

function preload() {
  workflow = loadJSON("workflow_api.json");
}

function setup() {
  createCanvas(512, 512);

  comfy = new ComfyUiP5Helper("https://your.comfyui.instance:8188");
  console.log("workflow is", workflow);

  let button = createButton('generate');
  button.mousePressed(requestImage);
}

function requestImage() {
  // we could make some changes to the workflow here,
  // such as changing the prompt or modifying the seed
  workflow[3].inputs.seed = random(9999999);

  comfy.run(workflow, gotImage);
}

function gotImage(results, err) {
  // results is an array of outputs from running the workflow
  console.log("gotImage", results);

  // you can load them like so
  if (results.length > 0) {
    resImg = loadImage(results[0].src);
  }

  // we could automatically run again if we wanted
  //requestImage();
}

function draw() {
  background(255);
  // if we have an image, put it onto the canvas
  if (resImg) {
    image(resImg, 0, 0, width, height);
  }
}
