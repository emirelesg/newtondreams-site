FROM php:7.2-apache
WORKDIR /var/www/html
COPY ./src/ .
# Will only work if host user id is 1000. $UID
RUN usermod -u 1000 www-data
EXPOSE 80
