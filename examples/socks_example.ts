import * as ProxyChain from "./../src";
import { gotScraping } from "got-scraping";

const server = new ProxyChain.Server({
    port: 8000,
    prepareRequestFunction: ({ request }: any) => {
        console.log("request");
        console.log(request.headers["user-agent"]);
        return {
            upstreamProxyUrl: "socks5://localhost:9150",
        };
    },
    verbose: true,
});

server.listen(() => {
    console.log(`Proxy server is listening on port ${8000}`);
});

server.on("tunnelConnectResponded", ({ response }: any) => {
    console.log(`CONNECT response headers received: ${response.headers}`);
});

//TODO: https://
setTimeout(() => {
    gotScraping
        .get({
            url: "https://httpbin.org/anything",
            proxyUrl: "https://localhost:8000",
        } as any)
        .then(({ body }) => console.log(body));
}, 5000);

setTimeout(() => {
    gotScraping
        .get({
            url: "http://httpbin.org/anything",
            proxyUrl: "http://localhost:8000",
        } as any)
        .then(({ body }) => console.log(body));
}, 5000);
