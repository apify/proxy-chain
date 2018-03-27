const { createTunnel } = require('./build/tcp_tunnel.js');

createTunnel('http://groups-BUYPROXIES63748:x2w8w5tyCYihKuBTpihBJDqHX@proxy.apify.com:8000', 'aws-eu-central-1-portal.0.dblayer.com:17031', {
    verbose: true,
    port: 9113,
}).then((tunnel) => {
    console.log(tunnel);
});
