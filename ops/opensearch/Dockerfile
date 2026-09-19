FROM opensearchproject/opensearch:3.8.0@sha256:bcc1797519726ceb6d651d4a3e60b7c30da91793914a8dfe75fd441d4f641509

RUN /usr/share/opensearch/bin/opensearch-plugin install --batch analysis-icu

# AIQSA does not consume top-query telemetry. Keep collection opt-in for all
# image consumers; explicit deployment/cluster settings retain precedence.
RUN printf '\n%s\n' \
    'search.insights.top_queries.latency.enabled: false' \
    'search.insights.top_queries.cpu.enabled: false' \
    'search.insights.top_queries.memory.enabled: false' \
    >> /usr/share/opensearch/config/opensearch.yml
