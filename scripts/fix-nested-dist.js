// Some Parcel/Node/OS combinations produce an extra nested copy of the
// entry's own containing folder inside the dist directory (e.g.
// com.vulkan.roon-dialed-up.sdPlugin/plug-in/plug-in/index.html instead of
// com.vulkan.roon-dialed-up.sdPlugin/plug-in/index.html). This hasn't been
// reproduced consistently across environments, so rather than chase the
// exact cause, this script normalizes the output after the fact: if the
// nesting happened, it flattens it; if it didn't, it's a safe no-op.
const fs = require("fs");
const path = require("path");

const targets = [
  path.join(__dirname, "..", "com.vulkan.roon-dialed-up.sdPlugin", "plug-in"),
  path.join(__dirname, "..", "com.vulkan.roon-dialed-up.sdPlugin", "property-inspector"),
];

targets.forEach((dir) => {
  const dirName = path.basename(dir);
  const nested = path.join(dir, dirName);

  if(fs.existsSync(nested) && fs.statSync(nested).isDirectory()) {
    console.log(`Flattening nested folder: ${nested}`);

    fs.readdirSync(nested).forEach((entry) => {
      fs.renameSync(path.join(nested, entry), path.join(dir, entry));
    });

    fs.rmdirSync(nested);
  }
});