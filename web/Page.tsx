import * as preact from "preact";
import { css } from "typesafecss";
import { observer } from "sliftutils/render-utils/observer";
import { HomePage } from "./HomePage";

@observer
export class Page extends preact.Component {
    render() {
        return (
            <div className={css.size("100vw", "100vh").vbox(0).alignItems("stretch").overflowHidden}>
                <HomePage />
            </div>
        );
    }
}
