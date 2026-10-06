/* eslint-disable no-extend-native */
/* eslint-disable @typescript-eslint/no-unsafe-return */

import md5 from "md5";
import { getFetch, isHumanVerificationShown } from "./utils";
import { auths } from "./file-magics";
import i18nextInit, { i18next } from "./i18n/index";

(async () => {
    await i18nextInit;
})();

export type FileType = "img" | "mp3" | "midi";

const getSuffix = async (
    scoreUrl: string,
    _fetch = getFetch()
): Promise<string | null> => {
    let suffixUrls: string[] = [];
    if (scoreUrl !== "") {
        const response = await _fetch(scoreUrl);
        const text = await response.text();
        suffixUrls = [
            ...text.matchAll(
                /link.+?href=["'](https:\/\/musescore\.com\/static\/public\/build\/musescore.*?(?:_es6)?\/20.+?\.js)["']/g
            ),
        ].map((match) => match[1]);
    } else {
        suffixUrls = [
            ...document.head.innerHTML.matchAll(
                /link.+?href=["'](https:\/\/musescore\.com\/static\/public\/build\/musescore.*?(?:_es6)?\/20.+?\.js)["']/g
            ),
        ].map((match) => match[1]);
    }

    for (const url of suffixUrls) {
        const response = await _fetch(url);
        const text = await response.text();

        const match = text.match(/"([^"]+)"\)\.substr\(0,4\)/);
        if (match) {
            return match[1];
        }
    }

    return null;
};

const getApiUrl = (id: number, type: FileType, index: number): string => {
    return `/api/jmuse?id=${id}&type=${type}&index=${index}`;
};

const getApiAuth = async (
    id: number,
    type: FileType,
    index: number,
    scoreUrl: string
): Promise<string> => {
    const code = `${id}${type}${index}${await getSuffix(scoreUrl)}`;
    return md5(code).slice(0, 4);
};

let scoreScrollPromise: Promise<void> | null = null;

/**
 * Scroll through every page of the score.
 *
 * The viewer lazy-loads each page as it scrolls into view, and obtains the
 * download token of that page through its own requests along the way. The
 * score therefore has to be scrolled through before those tokens can be read,
 * and scrolling is also what makes MuseScore ask for a human verification.
 *
 * Callers that need different pages at the same time share one scroll pass.
 */
const scrollThroughScore = (pageCount = 0): Promise<void> => {
    if (!scoreScrollPromise) {
        scoreScrollPromise = new Promise<void>((resolve) => {
            const parentDiv = document.querySelector(
                "#jmuse-scroller-component"
            );

            if (!parentDiv) {
                resolve();
                return;
            }

            const pageCooldown = 25;
            let i = 0;

            const scrollToNextChild = (): void => {
                // the viewer appends the pages while scrolling, so the page
                // count has to be re-read instead of being fixed upfront
                const target = pageCount
                    ? Math.min(parentDiv.children.length, pageCount + 3)
                    : parentDiv.children.length;

                parentDiv.children[i]?.scrollIntoView();

                i++;

                if (i < target) {
                    setTimeout(scrollToNextChild, pageCooldown);
                } else {
                    resolve();
                }
            };

            scrollToNextChild();
        }).finally(() => {
            scoreScrollPromise = null;
        });
    }

    return scoreScrollPromise;
};

const getApiAuthNetwork = async (
    type: FileType,
    index: number,
    pageCount = 0,
    setText?: (str: string) => void
): Promise<string> => {
    let numPages = pageCount;
    const pageCooldown = 25;
    if (!auths[type + index]) {
        try {
            switch (type) {
                case "midi": {
                    const fsBtn = document.querySelector(
                        'button[title="Toggle Fullscreen"]'
                    ) as HTMLButtonElement;
                    if (!fsBtn) {
                        // mobile device
                        document
                            .querySelector("button[title='Open Mixer']")
                            ?.click();
                        const observer = new MutationObserver(() => {
                            if (
                                document.querySelector(
                                    "body > article[role='dialog']"
                                )
                            ) {
                                let audioSources = document.querySelector(
                                    "body > article[role='dialog'] select"
                                );

                                if (audioSources !== null) {
                                    audioSources.querySelector(
                                        "option[value='0']"
                                    )?.selected = true;

                                    audioSources.dispatchEvent(
                                        new Event("change")
                                    );
                                }
                                document
                                    .querySelector(
                                        "article[role='dialog'] header > button"
                                    )
                                    ?.click();
                            }
                        });
                        observer.observe(document.body, {
                            childList: true,
                            subtree: true,
                        });
                    } else {
                        const el =
                            fsBtn.parentElement?.parentElement?.querySelector(
                                "button"
                            ) as HTMLButtonElement;
                        el.click();
                    }
                    break;
                }
                case "mp3": {
                    const el = document.querySelector(
                        'button[title="Toggle Play"]'
                    ) as HTMLButtonElement;
                    if (!el) {
                        // mobile device
                        document.querySelector("#scorePlayButton")?.click();
                    } else {
                        el.click();
                    }
                    break;
                }
                case "img": {
                    numPages = Math.max(
                        pageCount,
                        document.querySelector("#jmuse-scroller-component")
                            ?.children.length ?? 0
                    );

                    // scroll through the whole score so that the viewer loads
                    // every page, and so that a human verification is triggered
                    // before the download is attempted
                    await scrollThroughScore(pageCount);
                    break;
                }
            }
        } catch (err) {
            console.error(err);
            throw Error;
        }
    }

    try {
        return new Promise((resolve, reject) => {
            const baseTimeout =
                type === "img" ? numPages * pageCooldown * 2 + 2100 : 5 * 1000;

            // While the human verification is shown, keep extending the
            // deadline so that the user has time to pass it. Without this the
            // download fails silently and produces an incomplete PDF.
            const verificationTimeout = 2 * 60 * 1000; /* 2min */
            let deadline = Date.now() + baseTimeout;
            let notified = false;

            // Check the auths object periodically
            const interval = setInterval(() => {
                if (Object.prototype.hasOwnProperty.call(auths, type + index)) {
                    clearInterval(interval);
                    setInterval(
                        () => {
                            resolve(auths[type + index]);
                        },
                        // long delay for images to give time for them to load fully
                        type === "img" ? 2000 : 100
                    );
                    return;
                }

                if (type === "img" && isHumanVerificationShown()) {
                    deadline = Date.now() + verificationTimeout;

                    if (setText && !notified) {
                        notified = true;
                        setText(i18next.t("human_verification_required"));
                    }
                }

                if (Date.now() > deadline) {
                    clearInterval(interval);
                    console.error(type, "token timeout");
                    reject(new Error("token timeout"));
                }
            }, 100);
        });
    } catch {
        console.error(type, "token timeout");
        throw Error;
    }
};

export const getFileUrl = async (
    id: number,
    type: FileType,
    scoreUrl = "",
    index = 0,
    _fetch = getFetch(),
    setText?: (str: string) => void,
    pageCount?: number
): Promise<string> => {
    const url = getApiUrl(id, type, index);
    let auth = await getApiAuth(id, type, index, scoreUrl);
    if (setText && pageCount) {
        const percent = Math.round(((index + 1) / pageCount) * 83);
        setText(`${percent}%`);
    }

    let r = await _fetch(url, {
        headers: {
            Authorization: auth,
        },
    });

    if (!r.ok) {
        auth = md5(`${id}${type}${index}9654,4e`).slice(0, 4);
        r = await _fetch(url, {
            headers: {
                Authorization: auth,
            },
        });

        if (!r.ok) {
            auth = await getApiAuthNetwork(type, index, pageCount, setText);
            if (type === "img" && index === 0) {
                // auth is the URL for the first page
                r = await _fetch(auth);
            } else {
                r = await _fetch(url, {
                    headers: {
                        Authorization: auth,
                    },
                });
            }
        }
    }

    const { info } = await r.json();
    return info.url as string;
};
