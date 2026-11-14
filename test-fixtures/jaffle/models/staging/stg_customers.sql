{# select * from {{ ref('commented_out') }} #}
select * from {{ source("raw", "customers") }}
