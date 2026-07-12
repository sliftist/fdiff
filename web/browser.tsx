import * as preact from "preact";
import { isNode } from "typesafecss";
import { configureMobxNextFrameScheduler } from "sliftutils/render-utils/mobxTyped";
import { Page } from "./Page";

function main() {
    if (isNode()) return;
    configureMobxNextFrameScheduler();
    let app = document.getElementById("app");
    if (!app) throw new Error(`Expected an #app element to render into, was ${app}`);
    preact.render(<Page />, app);
}

main();
