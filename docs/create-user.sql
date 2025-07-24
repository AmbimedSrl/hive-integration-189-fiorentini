/* 1) create the user (change host  and password!) */
CREATE USER 'report_user'@'%' IDENTIFIED BY 'zsCWww7sDLZ$GEwMp0OwfIPG';

/* 2) grant just the rights needed to read data */
GRANT SELECT, SHOW VIEW ON `ambimed_backoffice`.* TO 'report_user'@'%';

/* 3) make the privilege change take effect */
FLUSH PRIVILEGES;