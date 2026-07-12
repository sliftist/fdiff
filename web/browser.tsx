import * as preact from "preact";
import { isNode } from "typesafecss";

function Page() {
    return (
        <div style={{ textAlign: "center" }}>
            <h1 style={{ fontSize: "3rem", margin: 0 }}>Hello World</h1>
            <p style={{ opacity: 0.6 }}>fdiff — built with the sliftutils bundler</p>
        </div>
    );
}

function main() {
    if (isNode()) return;
    preact.render(<Page />, document.getElementById("app")!);
}

main();
